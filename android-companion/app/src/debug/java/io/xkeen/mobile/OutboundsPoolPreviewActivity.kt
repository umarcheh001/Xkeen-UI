package io.xkeen.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import io.xkeen.mobile.app.CompanionApp
import io.xkeen.mobile.app.CompanionController
import io.xkeen.mobile.app.OutboundPoolEditorState
import io.xkeen.mobile.app.OutboundPoolEntryDraft
import io.xkeen.mobile.app.normalizeOutboundLink
import io.xkeen.mobile.app.previewOutboundLink

/** Debug-only pool editor review entry point. It is excluded from release builds and performs no I/O. */
class OutboundsPoolPreviewActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        val base = outboundsPreviewState()
        val controller = CompanionController(
            initialState = base.copy(
                outbounds = base.outbounds.copy(
                    poolEditor = OutboundPoolEditorState(
                        isOpen = true,
                        canEdit = true,
                        entries = previewPoolEntries,
                        sourceFingerprint = "debug-preview",
                        restartAfterSave = true,
                        message = "Ссылки нормализованы локально. Проверьте tag и режим сохранения.",
                    ),
                ),
            ),
        )
        setContent { CompanionApp(controller) }
    }
}

private val previewPoolEntries = listOf(
    previewPoolEntry(
        "nl-amsterdam",
        "vless://123e4567-e89b-12d3-a456-426614174000@nl.example.net:443?security=tls&type=ws&path=socket#Amsterdam",
    ),
    previewPoolEntry(
        "de-berlin",
        "trojan://secret@de.example.net:443?security=tls#Berlin",
    ),
)

private fun previewPoolEntry(tag: String, rawUrl: String): OutboundPoolEntryDraft {
    val url = normalizeOutboundLink(rawUrl) ?: rawUrl
    return OutboundPoolEntryDraft(tag = tag, url = url, preview = previewOutboundLink(url))
}
