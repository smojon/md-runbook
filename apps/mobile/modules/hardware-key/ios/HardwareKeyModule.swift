import CryptoKit
import ExpoModulesCore
import Foundation
import Security

/// The app's SSH key: a P-256 key made in the Secure Enclave, or a Keychain key where there is no
/// Secure Enclave (the simulator). The private key is never exported; JavaScript gets the public
/// key and signatures.
public final class HardwareKeyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HardwareKey")

    AsyncFunction("publicKey") { (alias: String) -> String? in
      guard let key = try HardwareKeyStore.find(alias) else { return nil }
      return try HardwareKeyStore.publicKeyBase64(key)
    }

    AsyncFunction("generate") { (alias: String) -> [String: Any] in
      try HardwareKeyStore.remove(alias)
      if SecureEnclave.isAvailable, let key = try? HardwareKeyStore.make(alias, enclave: true) {
        return ["publicKey": try HardwareKeyStore.publicKeyBase64(key), "hardware": true]
      }
      let key = try HardwareKeyStore.make(alias, enclave: false)
      return ["publicKey": try HardwareKeyStore.publicKeyBase64(key), "hardware": false]
    }

    AsyncFunction("sign") { (alias: String, data: String) -> String in
      guard let key = try HardwareKeyStore.find(alias) else { throw HardwareKeyError("no key named \(alias)") }
      guard let bytes = Data(base64Encoded: data) else { throw HardwareKeyError("data is not base64") }
      var error: Unmanaged<CFError>?
      guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, bytes as CFData, &error) else {
        throw HardwareKeyError.from(error, "signing failed")
      }
      return (signature as Data).base64EncodedString()
    }

    AsyncFunction("remove") { (alias: String) in
      try HardwareKeyStore.remove(alias)
    }

    AsyncFunction("isHardware") { (alias: String) -> Bool in
      return try HardwareKeyStore.isEnclave(alias)
    }
  }
}

struct HardwareKeyError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }

  static func from(_ error: Unmanaged<CFError>?, _ what: String) -> HardwareKeyError {
    if let e = error?.takeRetainedValue() { return HardwareKeyError("\(what): \(e.localizedDescription)") }
    return HardwareKeyError(what)
  }
}

enum HardwareKeyStore {
  static func tag(_ alias: String) -> Data { Data("dev.mdrunbook.key.\(alias)".utf8) }

  static func query(_ alias: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag(alias),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
    ]
  }

  static func make(_ alias: String, enclave: Bool) throws -> SecKey {
    var error: Unmanaged<CFError>?
    // Usable after the first unlock, on this device only (no backups, no migration to another phone).
    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      enclave ? [.privateKeyUsage] : [],
      &error
    ) else { throw HardwareKeyError.from(error, "access control") }
    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag(alias),
        kSecAttrAccessControl as String: access,
      ] as [String: Any],
    ]
    if enclave { attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw HardwareKeyError.from(error, "making the key failed")
    }
    return key
  }

  static func find(_ alias: String) throws -> SecKey? {
    var q = query(alias)
    q[kSecReturnRef as String] = true
    var item: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let item else { throw HardwareKeyError("Keychain error \(status)") }
    return (item as! SecKey)
  }

  static func isEnclave(_ alias: String) throws -> Bool {
    var q = query(alias)
    q[kSecReturnAttributes as String] = true
    var item: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &item)
    if status == errSecItemNotFound { return false }
    guard status == errSecSuccess, let attrs = item as? [String: Any] else { throw HardwareKeyError("Keychain error \(status)") }
    return (attrs[kSecAttrTokenID as String] as? String) == (kSecAttrTokenIDSecureEnclave as String)
  }

  static func remove(_ alias: String) throws {
    let status = SecItemDelete(query(alias) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw HardwareKeyError("Keychain error \(status)") }
  }

  /// The public key as the uncompressed point (0x04 ‖ X ‖ Y), base64.
  static func publicKeyBase64(_ key: SecKey) throws -> String {
    guard let pub = SecKeyCopyPublicKey(key) else { throw HardwareKeyError("no public key") }
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(pub, &error) else { throw HardwareKeyError.from(error, "public key") }
    return (data as Data).base64EncodedString()
  }
}
