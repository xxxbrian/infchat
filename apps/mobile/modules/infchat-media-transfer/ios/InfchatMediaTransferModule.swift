import ExpoModulesCore
import Foundation

private struct UploadFileOptions: Record {
  @Field var fileUri: String = ""
  @Field var headers: [String: String] = [:]
  @Field var method: String = "PUT"
  @Field var url: String = ""
}

private struct UploadFilePartOptions: Record {
  @Field var fileUri: String = ""
  @Field var headers: [String: String] = [:]
  @Field var length: Int64 = 0
  @Field var method: String = "PUT"
  @Field var offset: Int64 = 0
  @Field var url: String = ""
}

private final class InfchatMediaTransferException: Exception, @unchecked Sendable {
  private let message: String

  init(_ message: String) {
    self.message = message
    super.init()
  }

  override var reason: String {
    message
  }
}

public final class InfchatMediaTransferModule: Module {
  public func definition() -> ModuleDefinition {
    Name("InfchatMediaTransfer")

    AsyncFunction("uploadFileAsync") { (options: UploadFileOptions) in
      try await uploadFile(options, appContext: appContext)
    }

    AsyncFunction("uploadFilePartAsync") { (options: UploadFilePartOptions) in
      try await uploadFilePart(options, appContext: appContext)
    }
  }
}

private func uploadFile(_ options: UploadFileOptions, appContext: AppContext?) async throws -> [String: Any] {
  let fileUrl = try parseURL(options.fileUri, fieldName: "fileUri")
  let uploadUrl = try parseURL(options.url, fieldName: "url")
  guard FileSystemUtilities.isReadableFile(appContext, fileUrl) else {
    throw InfchatMediaTransferException("Upload file is not readable.")
  }

  var request = URLRequest(url: uploadUrl)
  request.httpMethod = normalizeMethod(options.method)
  for (key, value) in options.headers {
    request.setValue(value, forHTTPHeaderField: key)
  }

  let (data, response) = try await URLSession.shared.upload(for: request, fromFile: fileUrl)
  return try uploadResult(data: data, response: response)
}

private func uploadFilePart(_ options: UploadFilePartOptions, appContext: AppContext?) async throws -> [String: Any] {
  if options.offset < 0 || options.length <= 0 {
    throw InfchatMediaTransferException("Upload part range is invalid.")
  }
  let fileUrl = try parseURL(options.fileUri, fieldName: "fileUri")
  let uploadUrl = try parseURL(options.url, fieldName: "url")
  guard FileSystemUtilities.isReadableFile(appContext, fileUrl) else {
    throw InfchatMediaTransferException("Upload file is not readable.")
  }

  let data = try readFilePart(fileUrl, offset: options.offset, length: options.length)
  var request = URLRequest(url: uploadUrl)
  request.httpMethod = normalizeMethod(options.method)
  for (key, value) in options.headers {
    request.setValue(value, forHTTPHeaderField: key)
  }

  let (responseData, response) = try await URLSession.shared.upload(for: request, from: data)
  return try uploadResult(data: responseData, response: response)
}

private func readFilePart(_ url: URL, offset: Int64, length: Int64) throws -> Data {
  let handle = try FileHandle(forReadingFrom: url)
  defer {
    try? handle.close()
  }

  try handle.seek(toOffset: UInt64(offset))
  guard let data = try handle.read(upToCount: Int(length)), data.count == Int(length) else {
    throw InfchatMediaTransferException("Upload part is outside of the file bounds.")
  }

  return data
}

private func uploadResult(data: Data, response: URLResponse) throws -> [String: Any] {
  guard let httpResponse = response as? HTTPURLResponse else {
    throw InfchatMediaTransferException("Upload did not return an HTTP response.")
  }

  var headers: [String: String] = [:]
  for (key, value) in httpResponse.allHeaderFields {
    guard let key = key as? String else {
      continue
    }
    headers[key] = String(describing: value)
  }

  return [
    "body": String(data: data, encoding: .utf8) ?? "",
    "etag": findHeader(headers, "etag") ?? "",
    "headers": headers,
    "status": httpResponse.statusCode
  ]
}

private func normalizeMethod(_ method: String) -> String {
  let trimmed = method.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
  return trimmed.isEmpty ? "PUT" : trimmed
}

private func parseURL(_ value: String, fieldName: String) throws -> URL {
  guard let url = URL(string: value) else {
    throw InfchatMediaTransferException("\(fieldName) is not a valid URL.")
  }

  return url
}

private func findHeader(_ headers: [String: String], _ name: String) -> String? {
  for (key, value) in headers where key.caseInsensitiveCompare(name) == .orderedSame {
    return value
  }

  return nil
}
