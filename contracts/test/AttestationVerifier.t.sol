// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {AttestationVerifier} from "../src/AttestationVerifier.sol";
import {RealQuote} from "./RealQuote.sol";

/// Builds 632-byte payloads with the real quote's layout, signed by a test
/// P-256 key, so registration paths (which need REPORT_DATA we control) can be
/// exercised. The real Intel-signed quote covers the signature path itself.
abstract contract QuoteFactory is Test {
    uint256 internal constant QUOTE_KEY = 0xA11CE;
    bytes internal constant MRTD =
        hex"409c0cd3e63d9ea54d817cf851983a220131262664ac8cd02cc6a2e19fd291d2fdd0cc035d7789b982a43a92a4424c99";
    bytes internal constant RTMR3 =
        hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30";

    function quoteKey() internal view returns (bytes32 x, bytes32 y) {
        (uint256 px, uint256 py) = vm.publicKeyP256(QUOTE_KEY);
        return (bytes32(px), bytes32(py));
    }

    function makePayload(bytes memory mrtd, bytes memory rtmr3, bytes32 reportData)
        internal
        pure
        returns (bytes memory p)
    {
        p = new bytes(632);
        for (uint256 i; i < 48; i++) {
            p[184 + i] = mrtd[i];
            p[520 + i] = rtmr3[i];
        }
        for (uint256 i; i < 32; i++) {
            p[568 + i] = reportData[i];
        }
    }

    function sign(bytes memory payload) internal pure returns (bytes32 r, bytes32 s) {
        return vm.signP256(QUOTE_KEY, sha256(payload));
    }
}

contract AttestationVerifierTest is QuoteFactory {
    AttestationVerifier internal real;
    AttestationVerifier internal v;
    bytes32 internal constant ENCLAVE = keccak256("enclave-1");
    address internal engine = makeAddr("engine");

    function setUp() public {
        real = new AttestationVerifier(RealQuote.MRTD, RealQuote.RTMR3, RealQuote.KEY_X, RealQuote.KEY_Y);
        (bytes32 x, bytes32 y) = quoteKey();
        v = new AttestationVerifier(MRTD, RTMR3, x, y);
    }

    function test_verifyQuote_acceptsRealIntelSignedQuote() public view {
        assertTrue(real.verifyQuote(RealQuote.PAYLOAD, RealQuote.R, RealQuote.S));
    }

    function test_verifyQuote_rejectsTamperedPayload() public {
        bytes memory p = RealQuote.PAYLOAD;
        p[0] ^= 0x01;
        vm.expectRevert(AttestationVerifier.BadSignature.selector);
        real.verifyQuote(p, RealQuote.R, RealQuote.S);
    }

    function test_verifyQuote_rejectsWrongMeasurement() public {
        bytes memory wrong = RealQuote.MRTD;
        wrong[47] ^= 0x01;
        AttestationVerifier w = new AttestationVerifier(wrong, RealQuote.RTMR3, RealQuote.KEY_X, RealQuote.KEY_Y);
        vm.expectRevert(AttestationVerifier.MeasurementMismatch.selector);
        w.verifyQuote(RealQuote.PAYLOAD, RealQuote.R, RealQuote.S);
    }

    function test_verifyQuote_rejectsWrongAppMeasurement() public {
        AttestationVerifier w = new AttestationVerifier(RealQuote.MRTD, RTMR3, RealQuote.KEY_X, RealQuote.KEY_Y);
        vm.expectRevert(AttestationVerifier.AppMeasurementMismatch.selector);
        w.verifyQuote(RealQuote.PAYLOAD, RealQuote.R, RealQuote.S);
    }

    function test_verifyQuote_rejectsBadLength() public {
        vm.expectRevert(AttestationVerifier.BadPayloadLength.selector);
        real.verifyQuote(new bytes(631), RealQuote.R, RealQuote.S);
    }

    function test_register_bindsEngineFromReportData() public {
        bytes memory p = makePayload(MRTD, RTMR3, v.registrationBinding(ENCLAVE, engine));
        (bytes32 r, bytes32 s) = sign(p);
        vm.prank(engine);
        v.registerVerifiedEnclave(ENCLAVE, p, r, s);
        assertTrue(v.isRegistered(ENCLAVE));
        assertEq(v.getEngineAddress(ENCLAVE), engine);
    }

    function test_register_rejectsReplayFromAnotherSender() public {
        // A valid quote naming `engine`, submitted by someone else, must fail:
        // the binding covers msg.sender. This is the front-run the Soroban
        // version documented as a residual gap.
        bytes memory p = makePayload(MRTD, RTMR3, v.registrationBinding(ENCLAVE, engine));
        (bytes32 r, bytes32 s) = sign(p);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(AttestationVerifier.ReportDataMismatch.selector);
        v.registerVerifiedEnclave(ENCLAVE, p, r, s);
    }

    function test_register_rejectsQuoteForAnotherVerifier() public {
        (bytes32 x, bytes32 y) = quoteKey();
        AttestationVerifier other = new AttestationVerifier(MRTD, RTMR3, x, y);
        bytes memory p = makePayload(MRTD, RTMR3, other.registrationBinding(ENCLAVE, engine));
        (bytes32 r, bytes32 s) = sign(p);
        vm.prank(engine);
        vm.expectRevert(AttestationVerifier.ReportDataMismatch.selector);
        v.registerVerifiedEnclave(ENCLAVE, p, r, s);
    }

    function test_register_onlyCurrentEngineCanRotate() public {
        test_register_bindsEngineFromReportData();
        address attacker = makeAddr("attacker");
        bytes memory p = makePayload(MRTD, RTMR3, v.registrationBinding(ENCLAVE, attacker));
        (bytes32 r, bytes32 s) = sign(p);
        vm.prank(attacker);
        vm.expectRevert(AttestationVerifier.NotCurrentOwner.selector);
        v.registerVerifiedEnclave(ENCLAVE, p, r, s);
    }

    function test_register_rejectsQuoteFromOtherKey() public {
        bytes memory p = makePayload(MRTD, RTMR3, v.registrationBinding(ENCLAVE, engine));
        (bytes32 r, bytes32 s) = vm.signP256(0xB0B, sha256(p));
        vm.prank(engine);
        vm.expectRevert(AttestationVerifier.BadSignature.selector);
        v.registerVerifiedEnclave(ENCLAVE, p, r, s);
    }

    function test_unknownEnclave() public view {
        assertFalse(v.isRegistered(ENCLAVE));
        assertEq(v.getEngineAddress(ENCLAVE), address(0));
    }
}
