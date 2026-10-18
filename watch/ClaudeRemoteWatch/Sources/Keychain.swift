// 配对信息（含手表自己的私钥）优先放钥匙串；钥匙串不可用时（比如没签名的模拟器构建）退到 App 自己的沙盒文件，
// 文件开「首次解锁前不可读」的保护，同样只有这个 App 能读
import Foundation
import Security

enum Keychain {
  private static let service = "io.claude-remote.watch"
  private static func fileURL(_ account: String) -> URL {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("\(account).bin")
  }
  static func save(_ data: Data, account: String) {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    SecItemDelete(q as CFDictionary)
    var add = q
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    if SecItemAdd(add as CFDictionary, nil) != errSecSuccess {
      try? data.write(to: fileURL(account), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }
  static func load(account: String) -> Data? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: AnyObject?
    if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data { return d }
    return try? Data(contentsOf: fileURL(account))
  }
  static func delete(account: String) {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    SecItemDelete(q as CFDictionary)
    try? FileManager.default.removeItem(at: fileURL(account))
  }
}
