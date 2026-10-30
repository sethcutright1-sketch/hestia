package com.householdapp.wear

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Talks to household-app's existing Express API using a device token (see
 * routes/devices.ts and auth.ts's deviceTokenAuth), sent as
 * `Authorization: Bearer <token>` on every request. Generate one from
 * AdminSettings -> Devices on a phone or browser, then enter it on the
 * watch's pairing screen (MainActivity.kt's SetupScreen) -- see this
 * project's README's "Pairing a watch" section.
 *
 * Deliberately not a session cookie: a device token is revocable from
 * AdminSettings without touching the account password, and doesn't expire
 * on its own the way a rolling session would if the watch went unused for a
 * while.
 */
class ApiClient(context: Context) {

    private val prefs = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "household_wear_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    /** e.g. "https://your-host.your-tailnet.ts.net" -- set once during pairing. */
    var baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_BASE_URL, value.trimEnd('/')).apply()

    private var deviceToken: String
        get() = prefs.getString(KEY_DEVICE_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_DEVICE_TOKEN, value).apply()

    val isPaired: Boolean get() = baseUrl.isNotBlank() && deviceToken.isNotBlank()

    private val http = OkHttpClient.Builder()
        .addInterceptor { chain ->
            val request = chain.request().newBuilder()
                .apply { if (deviceToken.isNotBlank()) addHeader("Authorization", "Bearer $deviceToken") }
                .build()
            chain.proceed(request)
        }
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS) // chat replies can involve tool calls; give them room
        .build()

    /** Stores the pairing details entered on SetupScreen. Doesn't verify the
     * token itself -- the first real request (e.g. todaysEvents) does that,
     * and its own failure is what tells the user pairing didn't take. */
    fun pair(serverUrl: String, token: String) {
        baseUrl = serverUrl
        deviceToken = token
    }

    fun unpair() {
        prefs.edit().remove(KEY_BASE_URL).remove(KEY_DEVICE_TOKEN).apply()
    }

    /** Today's calendar events -- GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD (routes/calendar.ts). */
    suspend fun todaysEvents(isoDate: String): Result<List<CalendarEvent>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = "$baseUrl/api/calendar?from=$isoDate&to=$isoDate"
            val request = Request.Builder().url(url).get().build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) error("Failed to load calendar (${response.code})")
                val json = JSONObject(response.body?.string() ?: "{}")
                val events = json.optJSONArray("events") ?: JSONArray()
                (0 until events.length()).map { i ->
                    val e = events.getJSONObject(i)
                    CalendarEvent(title = e.optString("title"), date = e.optString("date"))
                }
            }
        }
    }

    /**
     * One-shot, non-streaming assistant turn: posts to the same SSE endpoint the
     * web UI uses (server.ts's POST /api/assistant/chat) but only reads through
     * to the final "done" event -- there's no useful place to render incremental
     * deltas on a watch face, so the intermediate `delta`/`tool_start`/`tool_end`
     * events are read and discarded rather than parsed out.
     *
     * inputMode is always "voice" here since every call from this app started
     * as spoken audio -- the server uses that, together with its own financial
     * classification and the admin-configurable `assistant.noFinanceVoiceData`
     * setting, to refuse a financial question before it ever reaches a model
     * (see server.ts's POST /api/assistant/chat and
     * assistant/providers/index.ts's blocksVoiceFinance). This app does not
     * need to, and does not, try to classify the question itself.
     */
    suspend fun chat(message: String, conversationId: String? = null): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val payload = JSONObject().put("message", message).put("inputMode", "voice")
            if (conversationId != null) payload.put("conversationId", conversationId)
            val body = payload.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder().url("$baseUrl/api/assistant/chat").post(body).build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) error("Assistant request failed (${response.code})")
                val text = response.body?.string() ?: ""
                parseSseReply(text) ?: error("No reply from assistant")
            }
        }
    }

    private fun parseSseReply(sseBody: String): String? {
        for (block in sseBody.split("\n\n")) {
            val eventLine = block.lineSequence().firstOrNull { it.startsWith("event:") } ?: continue
            if (eventLine.substringAfter("event:").trim() != "done") continue
            val dataLine = block.lineSequence().firstOrNull { it.startsWith("data:") } ?: continue
            val data = JSONObject(dataLine.substringAfter("data:").trim())
            return data.optString("reply")
        }
        return null
    }

    companion object {
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_DEVICE_TOKEN = "device_token"
    }
}

data class CalendarEvent(val title: String, val date: String)
