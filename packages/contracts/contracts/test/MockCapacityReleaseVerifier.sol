// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICapacityReleaseVerifier} from "../interfaces/ICapacityReleaseVerifier.sol";

/// @dev Development/test verifier only. Provenance values are explicit sentinels.
contract MockCapacityReleaseVerifier is ICapacityReleaseVerifier {
    bytes32 public constant circuitArtifactHash =
        0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 public constant verificationKeyHash =
        0x4444444444444444444444444444444444444444444444444444444444444444;

    bool public result = true;

    function setResult(bool nextResult) external {
        result = nextResult;
    }

    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[9] calldata
    ) external view returns (bool) {
        return result;
    }
}
