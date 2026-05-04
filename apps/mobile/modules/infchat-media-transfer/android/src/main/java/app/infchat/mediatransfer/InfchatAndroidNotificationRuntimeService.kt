package app.infchat.mediatransfer

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.abs

class InfchatAndroidNotificationRuntimeService : Service() {
  private var authToken = ""
  private var baseUrl = ""
  private var cursor = 0
  private var isRunning = false
  private var loopThread: Thread? = null
  private val notifiedCallIds = mutableSetOf<String>()
  private val notifiedMessageIds = mutableSetOf<String>()
  private var userId = ""

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }

    baseUrl = intent?.getStringExtra(EXTRA_BASE_URL).orEmpty().trim().trimEnd('/')
    authToken = intent?.getStringExtra(EXTRA_AUTH_TOKEN).orEmpty().trim()
    userId = intent?.getStringExtra(EXTRA_USER_ID).orEmpty().trim()
    createChannels()
    startForeground(SYNC_NOTIFICATION_ID, syncNotification())
    startLoopIfNeeded()

    return START_NOT_STICKY
  }

  override fun onDestroy() {
    isRunning = false
    loopThread?.interrupt()
    loopThread = null
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  private fun startLoopIfNeeded() {
    if (isRunning || baseUrl.isBlank() || authToken.isBlank() || userId.isBlank()) {
      return
    }
    isRunning = true
    loopThread = Thread {
      while (isRunning && !Thread.currentThread().isInterrupted) {
        try {
          pollOnce()
          Thread.sleep(POLL_INTERVAL_MS)
        } catch (_: InterruptedException) {
          return@Thread
        } catch (_: Throwable) {
          try {
            Thread.sleep(RETRY_INTERVAL_MS)
          } catch (_: InterruptedException) {
            return@Thread
          }
        }
      }
    }.apply {
      name = "InfChatNotificationRuntime"
      start()
    }
  }

  private fun pollOnce() {
    if (cursor <= 0) {
      val bootstrap = getJson("/api/infchat/bootstrap")
      cursor = bootstrap.optInt("cursor", 0)
    } else {
      val sync = getJson("/api/infchat/sync?cursor=$cursor")
      val events = sync.optJSONArray("events") ?: JSONArray()
      for (index in 0 until events.length()) {
        handleEvent(events.optJSONObject(index) ?: continue)
      }
      cursor = sync.optInt("cursor", cursor)
    }
    pollActiveCalls()
  }

  private fun pollActiveCalls() {
    val response = getJson("/api/infchat/calls/active")
    val callRooms = response.optJSONArray("callRooms") ?: JSONArray()
    for (index in 0 until callRooms.length()) {
      val callRoom = callRooms.optJSONObject(index) ?: continue
      val callRoomId = callRoom.optString("id")
      if (callRoom.optString("status") != "ringing" || callRoom.optString("created_by") == userId) {
        continue
      }
      if (callRoomId.isBlank() || !notifiedCallIds.add(callRoomId)) {
        continue
      }
      showIncomingCallNotification(callRoom)
    }
  }

  private fun handleEvent(event: JSONObject) {
    if (event.optString("type") != "message.created") {
      return
    }
    val payload = payloadObject(event) ?: return
    val message = payload.optJSONObject("message") ?: return
    val messageId = message.optString("id")
    if (messageId.isBlank() || message.optString("sender") == userId || message.optString("kind") == "call") {
      return
    }
    if (!notifiedMessageIds.add(messageId)) {
      return
    }

    val conversation = payload.optJSONObject("conversation")
    val title = conversation?.optString("title")?.takeIf { it.isNotBlank() } ?: "InfChat"
    val body = message.optString("body").ifBlank { "New message" }
    showMessageNotification(messageId, message.optString("conversation"), title, body)
  }

  private fun payloadObject(event: JSONObject): JSONObject? {
    val raw = event.opt("payload") ?: return null
    return when (raw) {
      is JSONObject -> raw
      is String -> runCatching { JSONObject(raw) }.getOrNull()
      else -> null
    }
  }

  private fun getJson(path: String): JSONObject {
    val connection = (URL(baseUrl + path).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 12_000
      readTimeout = 12_000
      setRequestProperty("Authorization", authToken)
    }
    try {
      val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
      val body = stream.bufferedReader().use(BufferedReader::readText)
      if (connection.responseCode !in 200..299) {
        throw IllegalStateException("HTTP ${connection.responseCode}: $body")
      }
      return JSONObject(body)
    } finally {
      connection.disconnect()
    }
  }

  private fun showMessageNotification(messageId: String, conversationId: String, title: String, body: String) {
    if (!canPostNotifications()) {
      return
    }
    val intent = deepLinkIntent("infchat://chat/$conversationId")
    val pendingIntent = PendingIntent.getActivity(
      this,
      abs(messageId.hashCode()),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val notification = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(title)
      .setContentText(body)
      .setContentIntent(pendingIntent)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .build()
    NotificationManagerCompat.from(this).notify(abs(messageId.hashCode()), notification)
  }

  private fun showIncomingCallNotification(callRoom: JSONObject) {
    if (!canPostNotifications()) {
      return
    }
    val callRoomId = callRoom.optString("id")
    val isVideo = callRoom.optString("kind") == "video"
    val title = if (isVideo) "Incoming video call" else "Incoming voice call"
    val openCallIntent = deepLinkIntent("infchat://call/$callRoomId")
    val fullScreenIntent = PendingIntent.getActivity(
      this,
      CALL_REQUEST_BASE + abs(callRoomId.hashCode()),
      openCallIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val declineIntent = PendingIntent.getBroadcast(
      this,
      DECLINE_REQUEST_BASE + abs(callRoomId.hashCode()),
      Intent(this, InfchatAndroidCallActionReceiver::class.java).apply {
        action = InfchatAndroidCallActionReceiver.ACTION_DECLINE_CALL
        putExtra(InfchatAndroidCallActionReceiver.EXTRA_BASE_URL, baseUrl)
        putExtra(InfchatAndroidCallActionReceiver.EXTRA_AUTH_TOKEN, authToken)
        putExtra(InfchatAndroidCallActionReceiver.EXTRA_CALL_ROOM_ID, callRoomId)
      },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val notification = NotificationCompat.Builder(this, CHANNEL_CALLS)
      .setSmallIcon(android.R.drawable.stat_sys_phone_call)
      .setContentTitle(title)
      .setContentText("Tap to answer in InfChat")
      .setContentIntent(fullScreenIntent)
      .setFullScreenIntent(fullScreenIntent, true)
      .addAction(android.R.drawable.ic_menu_call, "Answer", fullScreenIntent)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", declineIntent)
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .build()
    NotificationManagerCompat.from(this).notify(CALL_NOTIFICATION_BASE + abs(callRoomId.hashCode()), notification)
  }

  private fun syncNotification() = NotificationCompat.Builder(this, CHANNEL_SYNC)
    .setSmallIcon(android.R.drawable.stat_notify_sync)
    .setContentTitle("InfChat is listening")
    .setContentText("Background notifications work while InfChat remains open.")
    .setOngoing(true)
    .setPriority(NotificationCompat.PRIORITY_LOW)
    .build()

  private fun deepLinkIntent(uri: String) = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
    setPackage(packageName)
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
  }

  private fun canPostNotifications(): Boolean {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
  }

  private fun createChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(CHANNEL_SYNC, "InfChat Background", NotificationManager.IMPORTANCE_LOW))
    manager.createNotificationChannel(NotificationChannel(CHANNEL_MESSAGES, "InfChat Messages", NotificationManager.IMPORTANCE_HIGH))
    manager.createNotificationChannel(NotificationChannel(CHANNEL_CALLS, "InfChat Calls", NotificationManager.IMPORTANCE_HIGH).apply {
      lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
    })
  }

  companion object {
    private const val ACTION_STOP = "app.infchat.mediatransfer.STOP_NOTIFICATION_RUNTIME"
    private const val CHANNEL_CALLS = "infchat_calls"
    private const val CHANNEL_MESSAGES = "infchat_messages"
    private const val CHANNEL_SYNC = "infchat_sync"
    private const val EXTRA_AUTH_TOKEN = "authToken"
    private const val EXTRA_BASE_URL = "baseUrl"
    private const val EXTRA_USER_ID = "userId"
    private const val POLL_INTERVAL_MS = 8_000L
    private const val RETRY_INTERVAL_MS = 15_000L
    private const val SYNC_NOTIFICATION_ID = 1201
    private const val CALL_NOTIFICATION_BASE = 20_000
    private const val CALL_REQUEST_BASE = 30_000
    private const val DECLINE_REQUEST_BASE = 40_000

    fun start(context: Context, baseUrl: String, authToken: String, userId: String) {
      val intent = Intent(context, InfchatAndroidNotificationRuntimeService::class.java).apply {
        putExtra(EXTRA_BASE_URL, baseUrl)
        putExtra(EXTRA_AUTH_TOKEN, authToken)
        putExtra(EXTRA_USER_ID, userId)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.startService(Intent(context, InfchatAndroidNotificationRuntimeService::class.java).apply {
        action = ACTION_STOP
      })
    }
  }
}
