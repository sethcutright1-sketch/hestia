package com.householdapp.wear

import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.*
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

/**
 * Scaffold home screen: quick actions (today's calendar, ask the assistant by
 * voice) plus device-token pairing (SetupScreen). This intentionally does not
 * include a budget/financial quick action -- see ApiClient.chat's doc comment
 * on why voice input needs to stay off financial questions (PLAN.md Stage 8b).
 */
class MainActivity : ComponentActivity() {

    private lateinit var apiClient: ApiClient
    private var tts: TextToSpeech? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        apiClient = ApiClient(applicationContext)
        tts = TextToSpeech(applicationContext) { }

        setContent {
            HouseholdWearApp(apiClient = apiClient, speak = { text -> tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, null) })
        }
    }

    override fun onDestroy() {
        tts?.shutdown()
        super.onDestroy()
    }
}

@Composable
fun HouseholdWearApp(apiClient: ApiClient, speak: (String) -> Unit) {
    var paired by remember { mutableStateOf(apiClient.isPaired) }

    MaterialTheme {
        if (!paired) {
            SetupScreen(apiClient) { paired = true }
        } else {
            HomeScreen(apiClient, speak)
        }
    }
}

private const val REMOTE_INPUT_RESULT_KEY = "text"

/** Launches the watch's own voice/keyboard text-entry activity (the same one
 * a reply-to-a-notification box uses) and returns whatever was entered, or
 * null if the user backed out. */
@Composable
private fun rememberTextEntryLauncher(onResult: (String) -> Unit) =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val text = result.data?.let { RemoteInput.getResultsFromIntent(it) }
            ?.getCharSequence(REMOTE_INPUT_RESULT_KEY)
            ?.toString()
            ?.trim()
        if (!text.isNullOrEmpty()) onResult(text)
    }

private fun textEntryIntent(label: String): Intent {
    val remoteInput = RemoteInput.Builder(REMOTE_INPUT_RESULT_KEY).setLabel(label).build()
    val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
    RemoteInputIntentHelper.putRemoteInputsExtra(intent, listOf(remoteInput))
    return intent
}

/**
 * Pairing screen: generate a device token from AdminSettings -> Devices on a
 * phone or browser (see the household-app README's "Pairing a watch"
 * section), then enter the server URL and that token here, one at a time,
 * via the watch's built-in text-entry activity (voice or its mini keyboard)
 * -- far more watch-typeable than a username+password pair would be.
 */
@Composable
fun SetupScreen(apiClient: ApiClient, onPaired: () -> Unit) {
    var serverUrl by remember { mutableStateOf(apiClient.baseUrl) }
    var status by remember { mutableStateOf("") }

    val urlLauncher = rememberTextEntryLauncher { entered -> serverUrl = entered }
    val tokenLauncher = rememberTextEntryLauncher { token ->
        if (serverUrl.isBlank()) {
            status = "Enter the server address first."
        } else {
            apiClient.pair(serverUrl, token)
            status = "Paired. Try \"Today's calendar\" to confirm it worked."
            onPaired()
        }
    }

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(text = "Household", style = MaterialTheme.typography.title3)
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = if (serverUrl.isBlank()) "Not set up yet" else serverUrl,
                style = MaterialTheme.typography.caption2,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center
            )
            Spacer(modifier = Modifier.height(8.dp))
            Chip(
                label = { Text("Set server address") },
                onClick = { urlLauncher.launch(textEntryIntent("Server address")) }
            )
            Spacer(modifier = Modifier.height(4.dp))
            Chip(
                label = { Text("Enter device token") },
                onClick = { tokenLauncher.launch(textEntryIntent("Device token")) }
            )
            if (status.isNotBlank()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(text = status, style = MaterialTheme.typography.caption2, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            }
        }
    }
}

@Composable
fun HomeScreen(apiClient: ApiClient, speak: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()

    var assistantReply by remember { mutableStateOf<String?>(null) }
    var todaysEvents by remember { mutableStateOf<List<CalendarEvent>?>(null) }

    val voiceLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val spoken = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?: return@rememberLauncherForActivityResult

        assistantReply = "Thinking..."
        scope.launch {
            apiClient.chat(spoken)
                .onSuccess { reply ->
                    assistantReply = reply
                    speak(reply)
                }
                .onFailure { err -> assistantReply = err.message ?: "Something went wrong." }
        }
    }

    fun launchVoice() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Ask Household")
        }
        voiceLauncher.launch(intent)
    }

    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize(),
        state = listState,
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 24.dp)
    ) {
        item {
            Text(text = "Household", style = MaterialTheme.typography.title3)
        }
        item {
            Chip(
                label = { Text("Ask Household") },
                secondaryLabel = { Text("Voice") },
                onClick = { launchVoice() }
            )
        }
        item {
            Chip(
                label = { Text("Today's calendar") },
                onClick = {
                    scope.launch {
                        val today = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
                        apiClient.todaysEvents(today)
                            .onSuccess { todaysEvents = it }
                            .onFailure { assistantReply = it.message }
                    }
                }
            )
        }
        assistantReply?.let { reply ->
            item {
                Card(onClick = {}) {
                    Text(text = reply, style = MaterialTheme.typography.body2)
                }
            }
        }
        todaysEvents?.let { events ->
            if (events.isEmpty()) {
                item { Text(text = "Nothing on today.", style = MaterialTheme.typography.caption2) }
            } else {
                items(events.size) { i ->
                    Text(text = events[i].title, style = MaterialTheme.typography.body2)
                }
            }
        }
    }
}
