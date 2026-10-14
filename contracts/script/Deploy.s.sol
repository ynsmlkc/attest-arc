// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {AttestationVerifier} from "../src/AttestationVerifier.sol";
import {SettlementVault, IAttestationVerifier} from "../src/SettlementVault.sol";

/// Deploys an AttestationVerifier pinned to one TDX app (MRTD + RTMR3 +
/// attestation key, all read from the CVM's own quote) and a SettlementVault
/// that trusts it.
///
///   MRTD=0x.. RTMR3=0x.. KEY_X=0x.. KEY_Y=0x.. forge script script/Deploy.s.sol \
///     --rpc-url arc --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract Deploy is Script {
    function run() external returns (AttestationVerifier verifier, SettlementVault vault) {
        bytes memory mrtd = vm.envBytes("MRTD");
        bytes memory rtmr3 = vm.envBytes("RTMR3");
        bytes32 keyX = vm.envBytes32("KEY_X");
        bytes32 keyY = vm.envBytes32("KEY_Y");

        vm.startBroadcast();
        verifier = new AttestationVerifier(mrtd, rtmr3, keyX, keyY);
        vault = new SettlementVault(IAttestationVerifier(address(verifier)));
        vm.stopBroadcast();

        console.log("AttestationVerifier", address(verifier));
        console.log("SettlementVault", address(vault));
    }
}
