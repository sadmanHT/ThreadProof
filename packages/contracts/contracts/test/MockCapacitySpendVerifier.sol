// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICapacitySpendVerifier} from "../interfaces/ICapacitySpendVerifier.sol";

contract MockCapacitySpendVerifier is ICapacitySpendVerifier {
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
