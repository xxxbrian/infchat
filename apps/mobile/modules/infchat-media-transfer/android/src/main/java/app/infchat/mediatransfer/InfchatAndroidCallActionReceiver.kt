package app.infchat.mediatransfer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

class InfchatAndroidCallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_DECLINE_CALL) {
      return
    }
    val baseUrl = intent.getStringExtra(EXTRA_BASE_URL).orEmpty().trim().trimEnd('/')
    val authToken = intent.getStringExtra(EXTRA_AUTH_TOKEN).orEmpty().trim()
    val callRoomId = intent.getStringExtra(EXTRA_CALL_ROOM_ID).orEmpty().trim()
    if (baseUrl.isBlank() || authToken.isBlank() || callRoomId.isBlank()) {
      return
    }
    Thread {
      runCatching {
        val connection = (URL("$baseUrl/api/infchat/calls/$callRoomId/end").openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          connectTimeout = 8_000
          readTimeout = 8_000
          doOutput = true
          setRequestProperty("Authorization", authToken)
        }
        try {
          connection.outputStream.use(OutputStream::flush)
          connection.inputStream.close()
        } finally {
          connection.disconnect()
        }
      }
    }.start()
  }

  companion object {
    const val ACTION_DECLINE_CALL = "app.infchat.mediatransfer.DECLINE_CALL"
    const val EXTRA_AUTH_TOKEN = "authToken"
    const val EXTRA_BASE_URL = "baseUrl"
    const val EXTRA_CALL_ROOM_ID = "callRoomId"
  }
}
