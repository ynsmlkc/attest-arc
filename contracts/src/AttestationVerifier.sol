// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title AttestationVerifier
/// @notice Verifies Intel TDX (DCAP v4) attestation quotes on-chain and keeps a
/// registry of enclaves that passed, plus the address each enclave signs with.
///
/// Port of Attest's Soroban contract. Same checks, same byte offsets (verified
/// there against Automata's public TDX test vector and two live Phala CVMs):
///   - the 632-byte signed payload (48-byte header + 584-byte TD report body)
///     carries a valid ECDSA P-256 signature from the pinned attestation key,
///     checked with Arc's P256VERIFY precompile (EIP-7951, 0x100);
///   - MRTD (payload 184..232) matches: genuine TDX + dstack firmware;
///   - RTMR3 (payload 520..568) matches: *this* app's compose, not just any app.
///
/// New on Arc: registration is bound to the quote's own REPORT_DATA
/// (payload 568..632). The enclave asks the hardware for a quote whose first 32
/// bytes of REPORT_DATA are `registrationBinding(enclaveId, engine)`, so a
/// quote only ever registers the engine address the enclave itself chose, on
/// this chain and this verifier. The Soroban version could not do this and
/// documented first-registration front-running as a residual gap.
contract AttestationVerifier {
    uint256 internal constant PAYLOAD_LEN = 632;
    uint256 internal constant MRTD_OFFSET = 184;
    uint256 internal constant RTMR3_OFFSET = 520;
    uint256 internal constant REPORT_DATA_OFFSET = 568;
    address internal constant P256_VERIFY = address(0x100);

    struct Enclave {
        address engine;
        uint64 verifiedAt;
    }

    /// Measurements are 48 bytes; stored as a 32-byte head plus a 16-byte tail.
    bytes32 public immutable mrtdHead;
    bytes16 public immutable mrtdTail;
    bytes32 public immutable rtmr3Head;
    bytes16 public immutable rtmr3Tail;
    /// The quote's attestation key (uncompressed P-256 point). Single key, not
    /// the full PCK chain to Intel's root CA, same scope as the Soroban version.
    bytes32 public immutable attestationKeyX;
    bytes32 public immutable attestationKeyY;

    mapping(bytes32 enclaveId => Enclave) private enclaves;

    event EnclaveRegistered(bytes32 indexed enclaveId, address indexed engine);

    error BadPayloadLength();
    error BadMeasurementLength();
    error MeasurementMismatch();
    error AppMeasurementMismatch();
    error BadSignature();
    error ReportDataMismatch();
    error NotEngine();
    error NotCurrentOwner();

    constructor(bytes memory mrtd, bytes memory rtmr3, bytes32 keyX, bytes32 keyY) {
        if (mrtd.length != 48 || rtmr3.length != 48) revert BadMeasurementLength();
        (mrtdHead, mrtdTail) = _split48(mrtd, 0);
        (rtmr3Head, rtmr3Tail) = _split48(rtmr3, 0);
        attestationKeyX = keyX;
        attestationKeyY = keyY;
    }

    /// @notice True if `payload` is a genuine quote for the pinned app.
    /// Reverts with the reason otherwise.
    function verifyQuote(bytes calldata payload, bytes32 r, bytes32 s) external view returns (bool) {
        _checkPayload(payload, r, s);
        return true;
    }

    /// @notice What the enclave must put in REPORT_DATA[0..32] to register
    /// `engine` under `enclaveId` on this verifier.
    function registrationBinding(bytes32 enclaveId, address engine) public view returns (bytes32) {
        return keccak256(abi.encodePacked("attest-arc:register:v1", block.chainid, address(this), enclaveId, engine));
    }

    /// @notice Registers `msg.sender` as the engine of `enclaveId`. The quote
    /// must pass every `verifyQuote` check and carry this exact registration in
    /// its signed REPORT_DATA. Only the current engine can rotate an existing
    /// registration (same rule as the Soroban hijack fix of 2026-09-13).
    function registerVerifiedEnclave(bytes32 enclaveId, bytes calldata payload, bytes32 r, bytes32 s) external {
        Enclave storage e = enclaves[enclaveId];
        if (e.engine != address(0) && e.engine != msg.sender) revert NotCurrentOwner();
        _checkPayload(payload, r, s);
        if (bytes32(payload[REPORT_DATA_OFFSET:REPORT_DATA_OFFSET + 32]) != registrationBinding(enclaveId, msg.sender))
        {
            revert ReportDataMismatch();
        }
        e.engine = msg.sender;
        e.verifiedAt = uint64(block.timestamp);
        emit EnclaveRegistered(enclaveId, msg.sender);
    }

    function isRegistered(bytes32 enclaveId) external view returns (bool) {
        return enclaves[enclaveId].engine != address(0);
    }

    /// @notice The registered engine, or address(0) if never registered.
    function getEngineAddress(bytes32 enclaveId) external view returns (address) {
        return enclaves[enclaveId].engine;
    }

    function getEnclave(bytes32 enclaveId) external view returns (address engine, uint64 verifiedAt) {
        Enclave storage e = enclaves[enclaveId];
        return (e.engine, e.verifiedAt);
    }

    function _checkPayload(bytes calldata payload, bytes32 r, bytes32 s) internal view {
        if (payload.length != PAYLOAD_LEN) revert BadPayloadLength();
        if (
            bytes32(payload[MRTD_OFFSET:MRTD_OFFSET + 32]) != mrtdHead
                || bytes16(payload[MRTD_OFFSET + 32:MRTD_OFFSET + 48]) != mrtdTail
        ) revert MeasurementMismatch();
        if (
            bytes32(payload[RTMR3_OFFSET:RTMR3_OFFSET + 32]) != rtmr3Head
                || bytes16(payload[RTMR3_OFFSET + 32:RTMR3_OFFSET + 48]) != rtmr3Tail
        ) revert AppMeasurementMismatch();

        // DCAP signs SHA-256(payload) with ECDSA over NIST P-256. EIP-7951
        // returns 32 bytes of 1 on success and empty output on failure.
        (bool ok, bytes memory out) =
            P256_VERIFY.staticcall(abi.encode(sha256(payload), r, s, attestationKeyX, attestationKeyY));
        if (!ok || out.length != 32 || abi.decode(out, (uint256)) != 1) revert BadSignature();
    }

    function _split48(bytes memory b, uint256 off) private pure returns (bytes32 head, bytes16 tail) {
        bytes32 second;
        assembly {
            head := mload(add(add(b, 32), off))
            second := mload(add(add(b, 64), off))
        }
        tail = bytes16(second);
    }
}
