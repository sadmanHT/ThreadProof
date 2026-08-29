// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ThreadProofEIP712
/// @notice Minimal EIP-712 domain hashing and strict 65-byte ECDSA recovery for ThreadProof business authorizations.
/// @dev Keeps the protocol compatible with pre-Cancun EVM targets while enforcing EIP-2 low-s signatures.
abstract contract ThreadProofEIP712 {
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    uint256 private constant _SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    bytes32 private immutable _nameHash;
    bytes32 private immutable _versionHash;

    error InvalidSignatureLength(uint256 length);
    error InvalidSignatureS(bytes32 s);
    error InvalidSignatureV(uint8 v);
    error InvalidSignature();

    constructor(string memory name, string memory version) {
        _nameHash = keccak256(bytes(name));
        _versionHash = keccak256(bytes(version));
    }

    function domainSeparatorV4() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                _nameHash,
                _versionHash,
                block.chainid,
                address(this)
            )
        );
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparatorV4(), structHash));
    }

    function _recoverTypedDataSigner(
        bytes32 structHash,
        bytes calldata signature
    ) internal view returns (address signer) {
        if (signature.length != 65) revert InvalidSignatureLength(signature.length);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }

        if (uint256(s) > _SECP256K1_HALF_ORDER) revert InvalidSignatureS(s);
        if (v != 27 && v != 28) revert InvalidSignatureV(v);

        signer = ecrecover(_hashTypedDataV4(structHash), v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
