import ExpoModulesCore
import Foundation
import QuickLook
import UIKit

private struct OpenDocumentOptions: Record {
  @Field var fileName: String = ""
  @Field var localUri: String = ""
  @Field var mimeType: String = ""
  @Field var title: String = ""
}

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

private final class DocumentPreviewController: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  let onDismiss: () -> Void
  let url: URL
  let promise: Promise

  init(url: URL, promise: Promise, onDismiss: @escaping () -> Void) {
    self.onDismiss = onDismiss
    self.url = url
    self.promise = promise
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    1
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    url as QLPreviewItem
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    onDismiss()
    promise.resolve(nil)
  }
}

public final class InfchatMediaTransferModule: Module {
  private var documentPreviewController: DocumentPreviewController?

  public func definition() -> ModuleDefinition {
    Name("InfchatMediaTransfer")

    AsyncFunction("openDocumentAsync") { (options: OpenDocumentOptions, promise: Promise) in
      try openDocument(options, promise: promise, module: self)
    }.runOnQueue(.main)

    AsyncFunction("uploadFileAsync") { (options: UploadFileOptions) in
      try await uploadFile(options, appContext: appContext)
    }

    AsyncFunction("uploadFilePartAsync") { (options: UploadFilePartOptions) in
      try await uploadFilePart(options, appContext: appContext)
    }
  }

  fileprivate func retainDocumentPreviewController(_ controller: DocumentPreviewController?) {
    documentPreviewController = controller
  }
}

private func openDocument(_ options: OpenDocumentOptions, promise: Promise, module: InfchatMediaTransferModule) throws {
  let fileUrl = try parseURL(options.localUri, fieldName: "localUri")
  guard FileSystemUtilities.isReadableFile(module.appContext, fileUrl) else {
    throw InfchatMediaTransferException("Document file is not readable.")
  }
  guard let currentViewController = module.appContext?.utilities?.currentViewController() else {
    throw InfchatMediaTransferException("A view controller is not available for document preview.")
  }

  if QLPreviewController.canPreview(fileUrl as QLPreviewItem) {
    let previewController = QLPreviewController()
    let delegate = DocumentPreviewController(url: fileUrl, promise: promise) { [weak module] in
      module?.retainDocumentPreviewController(nil)
    }
    module.retainDocumentPreviewController(delegate)
    previewController.dataSource = delegate
    previewController.delegate = delegate
    previewController.title = options.title.isEmpty ? options.fileName : options.title
    currentViewController.present(previewController, animated: true)
    return
  }

  let activityController = UIActivityViewController(activityItems: [fileUrl], applicationActivities: nil)
  activityController.title = options.title.isEmpty ? options.fileName : options.title
  activityController.completionWithItemsHandler = { _, _, _, _ in
    promise.resolve(nil)
  }
  if UIDevice.current.userInterfaceIdiom == .pad {
    activityController.popoverPresentationController?.sourceView = currentViewController.view
    activityController.popoverPresentationController?.sourceRect = CGRect(
      x: currentViewController.view.frame.midX,
      y: currentViewController.view.frame.maxY,
      width: 0,
      height: 0
    )
  }
  currentViewController.present(activityController, animated: true)
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
