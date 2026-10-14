// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAttestationVerifier {
    function getEngineAddress(bytes32 enclaveId) external view returns (address);
}

/// @title SettlementVault
/// @notice Holds traders' deposits and settles trades matched off-chain by a
/// matching engine running inside an attested TEE.
///
/// Port of Attest's Soroban vault. Two independent gates on `settle`:
///  1. The engine: `msg.sender` must be the address the AttestationVerifier
///     registered for `enclaveId`, which only a quote from the pinned TDX app
///     can do.
///  2. The traders: each order is EIP-712 signed by its trader; the vault
///     verifies the signature, tracks fills (partial fills, no overfill), and
///     enforces the signed limit price and order age. A compromised engine can
///     only execute what traders signed for.
/// Balances are internal; tokens move only on deposit and withdraw.
contract SettlementVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Order {
        address party;
        address giveToken;
        uint256 giveAmount;
        address wantToken;
        uint256 wantAmount;
        /// Signing time, milliseconds since the Unix epoch.
        uint64 ts;
        /// The enclave the trader is willing to have match this order.
        bytes32 enclaveId;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address party,address giveToken,uint256 giveAmount,address wantToken,uint256 wantAmount,uint64 ts,bytes32 enclaveId)"
    );
    uint64 public constant MAX_ORDER_AGE_MS = 7 days * 1000;
    uint64 public constant MAX_ORDER_FUTURE_MS = 10 minutes * 1000;

    IAttestationVerifier public immutable verifier;

    mapping(address token => mapping(address owner => uint256)) public balanceOf;
    /// How much of an order (by EIP-712 digest) has been settled, in giveToken units.
    mapping(bytes32 digest => uint256) public filled;

    event Deposited(address indexed owner, address indexed token, uint256 amount);
    event Withdrawn(address indexed owner, address indexed token, uint256 amount);
    event Settled(
        bytes32 indexed enclaveId,
        address indexed partyA,
        address indexed partyB,
        bytes32 digestA,
        bytes32 digestB,
        address tokenA,
        uint256 fillA,
        address tokenB,
        uint256 fillB
    );
    event OrderCancelled(bytes32 indexed digest, address indexed party);

    error InvalidAmount();
    error InsufficientBalance();
    error EngineMismatch();
    error OrderMismatch();
    error WrongEnclave();
    error OrderExpired();
    error BadSignature();
    error OrderOverfilled();
    error OrderPriceViolated();
    error NotOrderOwner();

    constructor(IAttestationVerifier verifier_) EIP712("Attest", "1") {
        verifier = verifier_;
    }

    function deposit(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        // Credit what actually arrived, not what was asked for.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        balanceOf[token][msg.sender] += received;
        emit Deposited(msg.sender, token, received);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 bal = balanceOf[token][msg.sender];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[token][msg.sender] = bal - amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    /// @notice Settles a match: `a.party` gives `fillA` of `a.giveToken`,
    /// `b.party` gives `fillB` of `b.giveToken`.
    function settle(
        bytes32 enclaveId,
        Order calldata a,
        bytes calldata sigA,
        uint256 fillA,
        Order calldata b,
        bytes calldata sigB,
        uint256 fillB
    ) external {
        if (fillA == 0 || fillB == 0) revert InvalidAmount();
        if (verifier.getEngineAddress(enclaveId) != msg.sender || msg.sender == address(0)) revert EngineMismatch();
        if (a.giveToken != b.wantToken || b.giveToken != a.wantToken) revert OrderMismatch();
        // Same-asset trades are only a legitimate no-op self-match when both
        // sides move the same amount; otherwise they would transfer value.
        if (a.giveToken == b.giveToken && fillA != fillB) revert InvalidAmount();

        bytes32 digestA = _consume(enclaveId, a, sigA, fillA, fillB);
        bytes32 digestB = _consume(enclaveId, b, sigB, fillB, fillA);

        _move(a.giveToken, a.party, b.party, fillA);
        _move(b.giveToken, b.party, a.party, fillB);

        emit Settled(enclaveId, a.party, b.party, digestA, digestB, a.giveToken, fillA, b.giveToken, fillB);
    }

    /// @notice Lets a trader kill the unfilled remainder of their own order.
    function cancel(Order calldata o) external {
        if (o.party != msg.sender) revert NotOrderOwner();
        bytes32 digest = hashOrder(o);
        filled[digest] = o.giveAmount;
        emit OrderCancelled(digest, msg.sender);
    }

    function hashOrder(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH, o.party, o.giveToken, o.giveAmount, o.wantToken, o.wantAmount, o.ts, o.enclaveId
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _consume(bytes32 enclaveId, Order calldata o, bytes calldata sig, uint256 giveFill, uint256 receiveFill)
        internal
        returns (bytes32 digest)
    {
        if (o.giveAmount == 0 || o.wantAmount == 0) revert InvalidAmount();
        if (o.enclaveId != enclaveId) revert WrongEnclave();

        uint256 nowMs = block.timestamp * 1000;
        if (o.ts > nowMs + MAX_ORDER_FUTURE_MS || (nowMs > o.ts && nowMs - o.ts > MAX_ORDER_AGE_MS)) {
            revert OrderExpired();
        }

        digest = hashOrder(o);
        // EOAs and ERC-1271 smart accounts both work.
        if (!SignatureChecker.isValidSignatureNow(o.party, digest, sig)) revert BadSignature();

        // Never settle more than the trader signed for...
        uint256 newFilled = filled[digest] + giveFill;
        if (newFilled > o.giveAmount) revert OrderOverfilled();
        // ...or at a worse price: receive/give >= wantAmount/giveAmount.
        if (receiveFill * o.giveAmount < giveFill * o.wantAmount) revert OrderPriceViolated();
        filled[digest] = newFilled;
    }

    function _move(address token, address from, address to, uint256 amount) internal {
        uint256 bal = balanceOf[token][from];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[token][from] = bal - amount;
        balanceOf[token][to] += amount;
    }
}
