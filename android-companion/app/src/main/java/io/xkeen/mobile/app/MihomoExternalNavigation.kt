package io.xkeen.mobile.app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import java.net.URI

internal fun mihomoZashboardUrl(baseUrl: String): String {
    val base = normalizeCompanionBaseUrl(baseUrl)
    return URI("http", null, base.host, 9090, "/ui", null, null).toString()
}

internal fun openMihomoZashboardInBrowser(context: Context, baseUrl: String) {
    val url = try {
        mihomoZashboardUrl(baseUrl)
    } catch (_: Exception) {
        Toast.makeText(context, "Некорректный адрес Xkeen UI.", Toast.LENGTH_SHORT).show()
        return
    }
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
        addCategory(Intent.CATEGORY_BROWSABLE)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "На устройстве не найден браузер.", Toast.LENGTH_SHORT).show()
    } catch (_: SecurityException) {
        Toast.makeText(context, "На устройстве не найден браузер.", Toast.LENGTH_SHORT).show()
    }
}
