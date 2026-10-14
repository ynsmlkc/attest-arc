// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AttestationVerifier} from "../src/AttestationVerifier.sol";
import {SettlementVault, IAttestationVerifier} from "../src/SettlementVault.sol";
import {QuoteFactory} from "./AttestationVerifier.t.sol";

contract Token is ERC20 {
    constructor(string memory n) ERC20(n, n) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SettlementVaultTest is QuoteFactory {
    AttestationVerifier internal verifier;
    SettlementVault internal vault;
    Token internal usdc;
    Token internal eurc;

    bytes32 internal constant ENCLAVE = keccak256("enclave-1");
    address internal engine = makeAddr("engine");
    uint256 internal aliceKey = 0xA11CE5;
    uint256 internal bobKey = 0xB0B5;
    address internal alice;
    address internal bob;

    function setUp() public {
        vm.warp(1_800_000_000);
        (bytes32 x, bytes32 y) = quoteKey();
        verifier = new AttestationVerifier(MRTD, RTMR3, x, y);
        bytes memory p = makePayload(MRTD, RTMR3, verifier.registrationBinding(ENCLAVE, engine));
        (bytes32 r, bytes32 s) = sign(p);
        vm.prank(engine);
        verifier.registerVerifiedEnclave(ENCLAVE, p, r, s);

        vault = new SettlementVault(IAttestationVerifier(address(verifier)));
        usdc = new Token("USDC");
        eurc = new Token("EURC");
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);
        _fund(alice, usdc, 1_000e6);
        _fund(bob, eurc, 1_000e6);
    }

    function _fund(address who, Token t, uint256 amount) internal {
        t.mint(who, amount);
        vm.startPrank(who);
        t.approve(address(vault), amount);
        vault.deposit(address(t), amount);
        vm.stopPrank();
    }

    function _order(address party, Token give, uint256 giveAmt, Token want, uint256 wantAmt)
        internal
        view
        returns (SettlementVault.Order memory)
    {
        return SettlementVault.Order({
            party: party,
            giveToken: address(give),
            giveAmount: giveAmt,
            wantToken: address(want),
            wantAmount: wantAmt,
            ts: uint64(block.timestamp * 1000),
            enclaveId: ENCLAVE
        });
    }

    function _sign(uint256 key, SettlementVault.Order memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    // alice: 116 USDC for 100 EURC; bob: 100 EURC for 115 USDC (crosses).
    function _pair() internal view returns (SettlementVault.Order memory a, SettlementVault.Order memory b) {
        a = _order(alice, usdc, 116e6, eurc, 100e6);
        b = _order(bob, eurc, 100e6, usdc, 115e6);
    }

    function test_deposit_withdraw() public {
        assertEq(vault.balanceOf(address(usdc), alice), 1_000e6);
        vm.prank(alice);
        vault.withdraw(address(usdc), 400e6);
        assertEq(usdc.balanceOf(alice), 400e6);
        assertEq(vault.balanceOf(address(usdc), alice), 600e6);
        vm.prank(alice);
        vm.expectRevert(SettlementVault.InsufficientBalance.selector);
        vault.withdraw(address(usdc), 601e6);
    }

    function test_settle_swapsBalances() public {
        (SettlementVault.Order memory a, SettlementVault.Order memory b) = _pair();
        bytes memory sigA = _sign(aliceKey, a);
        bytes memory sigB = _sign(bobKey, b);
        vm.prank(engine);
        vault.settle(ENCLAVE, a, sigA, 116e6, b, sigB, 100e6);
        assertEq(vault.balanceOf(address(usdc), alice), 884e6);
        assertEq(vault.balanceOf(address(usdc), bob), 116e6);
        assertEq(vault.balanceOf(address(eurc), alice), 100e6);
        assertEq(vault.balanceOf(address(eurc), bob), 900e6);
    }

    function test_settle_rejectsNonEngine() public {
        (SettlementVault.Order memory a, SettlementVault.Order memory b) = _pair();
        bytes memory sa = _sign(aliceKey, a);
        bytes memory sb = _sign(bobKey, b);
        vm.prank(makeAddr("not-engine"));
        vm.expectRevert(SettlementVault.EngineMismatch.selector);
        vault.settle(ENCLAVE, a, sa, 116e6, b, sb, 100e6);
    }

    function test_settle_rejectsUnregisteredEnclave() public {
        (SettlementVault.Order memory a, SettlementVault.Order memory b) = _pair();
        bytes memory sa = _sign(aliceKey, a);
        bytes memory sb = _sign(bobKey, b);
        vm.prank(engine);
        vm.expectRevert(SettlementVault.EngineMismatch.selector);
        vault.settle(keccak256("other"), a, sa, 116e6, b, sb, 100e6);
    }

    function test_settle_rejectsAlteredOrder() public {
        (SettlementVault.Order memory a, SettlementVault.Order memory b) = _pair();
        bytes memory sa = _sign(aliceKey, a);
        a.wantAmount = 50e6; // engine tries to fill alice at a worse price
        bytes memory sigB = _sign(bobKey, b);
        vm.prank(engine);
        vm.expectRevert(SettlementVault.BadSignature.selector);
        vault.settle(ENCLAVE, a, sa, 116e6, b, sigB, 100e6);
    }

    function test_settle_rejectsSignatureFromOtherKey() public {
        (SettlementVault.Order memory a, SettlementVault.Order memory b) = _pair();
        bytes memory sigA = _sign(bobKey, a);
        bytes memory sigB = _sign(bobKey, b);
        vm.prank(engine);
        vm.expectRevert(SettlementVault.BadSignature.selector);
        vault.settle(ENCLAVE, a, sigA, 116e6, b, sigB, 100e6);
    }

    function test_settle_rejectsWorseThanLimit() public {
        (SettlementVault.Order memory a, SettlementVault.Order memory b) = _pair();
        bytes memory sa = _sign(aliceKey, a);
        bytes memory sb = _sign(bobKey, b);
        // bob would receive 114 USDC for 100 EURC, below his signed 115.
        vm.prank(engine);
        vm.expectRevert(SettlementVault.OrderPriceViolated.selector);
        vault.settle(ENCLAVE, a, sa, 114e6, b, sb, 100e6);
    }

    function test_settle_partialFillsAndNoOverfill() public {
        (SettlementVault.Order memory a, SettlementVault.Order memory b) = _pair();
        bytes memory sa = _sign(aliceKey, a);
        bytes memory sb = _sign(bobKey, b);
        vm.startPrank(engine);
        vault.settle(ENCLAVE, a, sa, 58e6, b, sb, 50e6);
        vault.settle(ENCLAVE, a, sa, 58e6, b, sb, 50e6);
        vm.expectRevert(SettlementVault.OrderOverfilled.selector);
        vault.settle(ENCLAVE, a, sa, 58e6, b, sb, 50e6);
        vm.stopPrank();
        assertEq(vault.balanceOf(address(eurc), alice), 100e6);
    }

    function test_settle_rejectsExpiredOrder() public {
        (SettlementVault.Order memory a, SettlementVault.Order memory b) = _pair();
        bytes memory sa = _sign(aliceKey, a);
        bytes memory sb = _sign(bobKey, b);
        vm.warp(block.timestamp + 8 days);
        vm.prank(engine);
        vm.expectRevert(SettlementVault.OrderExpired.selector);
        vault.settle(ENCLAVE, a, sa, 116e6, b, sb, 100e6);
    }

    function test_settle_rejectsOrderForOtherEnclave() public {
        (SettlementVault.Order memory a, SettlementVault.Order memory b) = _pair();
        a.enclaveId = keccak256("other");
        bytes memory sigA = _sign(aliceKey, a);
        bytes memory sigB = _sign(bobKey, b);
        vm.prank(engine);
        vm.expectRevert(SettlementVault.WrongEnclave.selector);
        vault.settle(ENCLAVE, a, sigA, 116e6, b, sigB, 100e6);
    }

    function test_settle_rejectsNonOppositeOrders() public {
        SettlementVault.Order memory a = _order(alice, usdc, 116e6, eurc, 100e6);
        SettlementVault.Order memory b = _order(bob, eurc, 100e6, eurc, 100e6);
        bytes memory sigA = _sign(aliceKey, a);
        bytes memory sigB = _sign(bobKey, b);
        vm.prank(engine);
        vm.expectRevert(SettlementVault.OrderMismatch.selector);
        vault.settle(ENCLAVE, a, sigA, 116e6, b, sigB, 100e6);
    }

    function test_settle_sameTokenOnlyWithEqualAmounts() public {
        _fund(bob, usdc, 10e6);
        SettlementVault.Order memory a = _order(alice, usdc, 5e6, usdc, 5e6);
        SettlementVault.Order memory b = _order(bob, usdc, 5e6, usdc, 4e6);
        bytes memory sa = _sign(aliceKey, a);
        bytes memory sb = _sign(bobKey, b);
        vm.prank(engine);
        vm.expectRevert(SettlementVault.InvalidAmount.selector);
        vault.settle(ENCLAVE, a, sa, 5e6, b, sb, 4e6);
        vm.prank(engine);
        vault.settle(ENCLAVE, a, sa, 5e6, b, sb, 5e6);
    }

    function test_cancel_blocksFurtherFills() public {
        (SettlementVault.Order memory a, SettlementVault.Order memory b) = _pair();
        bytes memory sa = _sign(aliceKey, a);
        bytes memory sb = _sign(bobKey, b);
        vm.prank(bob);
        vm.expectRevert(SettlementVault.NotOrderOwner.selector);
        vault.cancel(a);
        vm.prank(alice);
        vault.cancel(a);
        vm.prank(engine);
        vm.expectRevert(SettlementVault.OrderOverfilled.selector);
        vault.settle(ENCLAVE, a, sa, 116e6, b, sb, 100e6);
    }
}
