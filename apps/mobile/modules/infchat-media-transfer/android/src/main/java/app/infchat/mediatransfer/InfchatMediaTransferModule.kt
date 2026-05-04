package app.infchat.mediatransfer

import android.content.Context
import android.content.Intent
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Rational
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.services.FilePermissionService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.EnumSet
import java.util.regex.Pattern

internal class OpenDocumentOptions : Record {
  @Field var fileName: String = ""
  @Field var localUri: String = ""
  @Field var mimeType: String? = null
  @Field var title: String = ""
}

internal class UploadFileOptions : Record {
  @Field var fileUri: String = ""
  @Field var headers: Map<String, String> = emptyMap()
  @Field var method: String = "PUT"
  @Field var url: String = ""
}

internal class UploadFilePartOptions : Record {
  @Field var fileUri: String = ""
  @Field var headers: Map<String, String> = emptyMap()
  @Field var length: Long = 0
  @Field var method: String = "PUT"
  @Field var offset: Long = 0
  @Field var url: String = ""
}

internal class AndroidNotificationRuntimeOptions : Record {
  @Field var authToken: String = ""
  @Field var baseUrl: String = ""
  @Field var userId: String = ""
}

internal class InfchatMediaTransferException(message: String, cause: Throwable? = null) :
  CodedException(message, cause)

class InfchatMediaTransferModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.AppContextLost()

  override fun definition() = ModuleDefinition {
    Name("InfchatMediaTransfer")

    AsyncFunction("canInstallUnknownAppsAsync") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
    }

    AsyncFunction("enterPictureInPictureAsync") { width: Int, height: Int ->
      enterPictureInPicture(width, height)
    }

    AsyncFunction("getNativeVersionCodeAsync") {
      getNativeVersionCode()
    }

    AsyncFunction("isPictureInPictureSupportedAsync") {
      isPictureInPictureSupported()
    }

    AsyncFunction("installApkAsync") Coroutine { fileUri: String ->
      withContext(Dispatchers.Main) {
        installApk(fileUri)
      }
    }

    AsyncFunction("openDocumentAsync") Coroutine { options: OpenDocumentOptions ->
      withContext(Dispatchers.Main) {
        openDocument(options)
      }
    }

    AsyncFunction("openInstallUnknownAppsSettingsAsync") {
      openInstallUnknownAppsSettings()
    }

    AsyncFunction("sha256FileAsync") Coroutine { fileUri: String ->
      withContext(Dispatchers.IO) {
        sha256File(fileUri)
      }
    }

    AsyncFunction("startAndroidNotificationRuntimeAsync") Coroutine { options: AndroidNotificationRuntimeOptions ->
      withContext(Dispatchers.Main) {
        InfchatAndroidNotificationRuntimeService.start(context, options.baseUrl, options.authToken, options.userId)
      }
    }

    AsyncFunction("stopAndroidNotificationRuntimeAsync") {
      InfchatAndroidNotificationRuntimeService.stop(context)
    }

    AsyncFunction("uploadFileAsync") Coroutine { options: UploadFileOptions ->
      withContext(Dispatchers.IO) {
        uploadFile(options)
      }
    }

    AsyncFunction("uploadFilePartAsync") Coroutine { options: UploadFilePartOptions ->
      withContext(Dispatchers.IO) {
        uploadFilePart(options)
      }
    }
  }

  private fun openDocument(options: OpenDocumentOptions) {
    val uri = Uri.parse(slashifyFilePath(options.localUri))
    ensureReadable(uri)
    val file = uri.toFile()
    if (!file.exists()) {
      throw InfchatMediaTransferException("Document file does not exist.")
    }

    val contentUri = FileProvider.getUriForFile(
      appContext.throwingActivity.application,
      "${appContext.throwingActivity.application.packageName}.FileSystemFileProvider",
      file
    )
    val mimeType = options.mimeType?.takeIf { it.isNotBlank() } ?: "*/*"
    val viewIntent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(contentUri, mimeType)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooserTitle = options.title.ifBlank { options.fileName.ifBlank { "Open file" } }
    val chooser = Intent.createChooser(viewIntent, chooserTitle).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val resolveInfos = context.packageManager.queryIntentActivities(
      chooser,
      PackageManager.MATCH_DEFAULT_ONLY
    )
    if (resolveInfos.isEmpty()) {
      throw InfchatMediaTransferException("No app is available to open this file.")
    }
    resolveInfos.forEach { resolveInfo ->
      context.grantUriPermission(
        resolveInfo.activityInfo.packageName,
        contentUri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION
      )
    }

    appContext.throwingActivity.startActivity(chooser)
  }

  private fun isPictureInPictureSupported(): Boolean {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
  }

  private fun enterPictureInPicture(width: Int, height: Int): Boolean {
    if (!isPictureInPictureSupported()) {
      return false
    }

    val params = PictureInPictureParams.Builder()
      .setAspectRatio(Rational(width.coerceAtLeast(1), height.coerceAtLeast(1)))
      .build()

    return appContext.throwingActivity.enterPictureInPictureMode(params)
  }

  private fun installApk(fileUri: String) {
    val uri = Uri.parse(slashifyFilePath(fileUri))
    ensureReadable(uri)
    val file = uri.toFile()
    if (!file.exists()) {
      throw InfchatMediaTransferException("APK file does not exist.")
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
      throw InfchatMediaTransferException("Unknown app installation is not allowed for InfChat.")
    }

    val contentUri = FileProvider.getUriForFile(
      appContext.throwingActivity.application,
      "${appContext.throwingActivity.application.packageName}.FileSystemFileProvider",
      file
    )
    val installIntent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(contentUri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.packageManager.queryIntentActivities(
      installIntent,
      PackageManager.MATCH_DEFAULT_ONLY
    ).forEach { resolveInfo ->
      context.grantUriPermission(
        resolveInfo.activityInfo.packageName,
        contentUri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION
      )
    }

    appContext.throwingActivity.startActivity(installIntent)
  }

  private fun openInstallUnknownAppsSettings() {
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
        data = Uri.parse("package:${context.packageName}")
      }
    } else {
      Intent(Settings.ACTION_SECURITY_SETTINGS)
    }.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    appContext.throwingActivity.startActivity(intent)
  }

  private fun getNativeVersionCode(): Long {
    val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
    } else {
      @Suppress("DEPRECATION")
      context.packageManager.getPackageInfo(context.packageName, 0)
    }

    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.longVersionCode
    } else {
      @Suppress("DEPRECATION")
      packageInfo.versionCode.toLong()
    }
  }

  private fun sha256File(fileUri: String): String {
    val uri = Uri.parse(slashifyFilePath(fileUri))
    ensureReadable(uri)
    val file = uri.toFile()
    if (!file.exists()) {
      throw InfchatMediaTransferException("File does not exist.")
    }
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val read = input.read(buffer)
        if (read <= 0) break
        digest.update(buffer, 0, read)
      }
    }

    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun uploadFile(options: UploadFileOptions): Bundle {
    val uri = Uri.parse(slashifyFilePath(options.fileUri))
    ensureReadable(uri)
    val file = uri.toFile()
    if (!file.exists()) {
      throw InfchatMediaTransferException("Upload file does not exist.")
    }

    return execute(options.url, options.method, options.headers, file.length()) { output ->
      FileInputStream(file).use { input -> input.copyTo(output) }
    }
  }

  private fun uploadFilePart(options: UploadFilePartOptions): Bundle {
    if (options.offset < 0 || options.length <= 0) {
      throw InfchatMediaTransferException("Upload part range is invalid.")
    }
    val uri = Uri.parse(slashifyFilePath(options.fileUri))
    ensureReadable(uri)
    val file = uri.toFile()
    if (!file.exists()) {
      throw InfchatMediaTransferException("Upload file does not exist.")
    }
    if (options.offset + options.length > file.length()) {
      throw InfchatMediaTransferException("Upload part is outside of the file bounds.")
    }

    return execute(options.url, options.method, options.headers, options.length) { output ->
      RangedFileInputStream(file, options.offset, options.length).use { input -> input.copyTo(output) }
    }
  }

  private fun execute(
    url: String,
    method: String,
    headers: Map<String, String>,
    contentLength: Long,
    writeBody: (OutputStream) -> Unit
  ): Bundle {
    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = normalizeMethod(method)
      connectTimeout = 60_000
      readTimeout = 60_000
      doOutput = true
      setFixedLengthStreamingMode(contentLength)
      headers.forEach { (key, value) -> setRequestProperty(key, value) }
    }

    try {
      connection.outputStream.use(writeBody)
      val status = connection.responseCode
      val bodyStream = if (status in 200..299) connection.inputStream else connection.errorStream
      val body = bodyStream?.bufferedReader()?.use { it.readText() } ?: ""
      val responseHeaders = translateHeaders(connection.headerFields)

      return Bundle().apply {
        putString("body", body)
        putString("etag", firstHeaderValue(connection.headerFields, "etag") ?: "")
        putBundle("headers", responseHeaders)
        putInt("status", status)
      }
    } finally {
      connection.disconnect()
    }
  }

  private fun ensureReadable(uri: Uri) {
    val permissions = when (uri.scheme) {
      "file" -> uri.path?.let { appContext.filePermission.getPathPermissions(context, it) }
      null -> EnumSet.of(FilePermissionService.Permission.READ)
      else -> EnumSet.noneOf(FilePermissionService.Permission::class.java)
    }
    if (permissions?.contains(FilePermissionService.Permission.READ) != true) {
      throw InfchatMediaTransferException("Upload file is not readable.")
    }
  }

  private fun Uri.toFile() = path?.let(::File) ?: throw InfchatMediaTransferException("Invalid file URI.")
}

private class RangedFileInputStream(file: File, offset: Long, private var remaining: Long) :
  InputStream() {
  private val input = FileInputStream(file)

  init {
    var skipped = 0L
    while (skipped < offset) {
      val next = input.skip(offset - skipped)
      if (next <= 0) {
        throw IOException("Unable to seek to upload part offset.")
      }
      skipped += next
    }
  }

  override fun read(): Int {
    if (remaining <= 0) {
      return -1
    }
    val value = input.read()
    if (value != -1) {
      remaining -= 1
    }

    return value
  }

  override fun read(buffer: ByteArray, byteOffset: Int, byteCount: Int): Int {
    if (remaining <= 0) {
      return -1
    }
    val requested = minOf(byteCount.toLong(), remaining).toInt()
    val read = input.read(buffer, byteOffset, requested)
    if (read > 0) {
      remaining -= read.toLong()
    }

    return read
  }

  override fun close() {
    input.close()
  }
}

private fun normalizeMethod(method: String): String {
  return method.trim().uppercase().ifEmpty { "PUT" }
}

private fun slashifyFilePath(path: String?): String? {
  return if (path == null) {
    null
  } else if (path.startsWith("file:///")) {
    path
  } else {
    Pattern.compile("^file:/*").matcher(path).replaceAll("file:///")
  }
}

private fun firstHeaderValue(headers: Map<String?, List<String>>, name: String): String? {
  headers.forEach { (key, values) ->
    if (key?.equals(name, ignoreCase = true) == true && values.isNotEmpty()) {
      return values.joinToString(", ")
    }
  }

  return null
}

private fun translateHeaders(headers: Map<String?, List<String>>): Bundle {
  val responseHeaders = Bundle()
  headers.forEach { (headerName, values) ->
    if (headerName == null || values.isEmpty()) {
      return@forEach
    }
    val value = values.joinToString(", ")
    if (responseHeaders.containsKey(headerName)) {
      responseHeaders.putString(headerName, responseHeaders.getString(headerName) + ", " + value)
    } else {
      responseHeaders.putString(headerName, value)
    }
  }

  return responseHeaders
}
