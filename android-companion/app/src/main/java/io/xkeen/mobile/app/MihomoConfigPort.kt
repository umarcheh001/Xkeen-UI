package io.xkeen.mobile.app

import org.json.JSONObject

internal data class MihomoConfigSnapshot(
    val content: String,
    val activeProfile: String = "config.yaml",
)

internal data class MihomoValidationResult(
    val valid: Boolean,
    val log: String,
)

internal interface MihomoConfigPort {
    suspend fun load(baseUrl: String): MihomoConfigSnapshot

    suspend fun validate(baseUrl: String, content: String): MihomoValidationResult

    suspend fun save(baseUrl: String, content: String, restart: Boolean): MihomoConfigSnapshot
}

internal class WebPanelMihomoConfigPort(
    private val transport: CompanionHttpTransport,
) : MihomoConfigPort {
    override suspend fun load(baseUrl: String): MihomoConfigSnapshot {
        val response = transport.get(
            CompanionHttpRequest(baseUrl = baseUrl, endpoint = "/api/mihomo-config"),
        )
        val root = response.requireJsonObject("Xkeen UI вернул неожиданный ответ загрузки YAML.")
        if (!root.optBoolean("ok", false)) {
            throw MihomoConfigException("Xkeen UI не подтвердил загрузку config.yaml.")
        }
        val content = root.optString("content")
        if (content.isBlank()) throw MihomoConfigException("Активный config.yaml пуст.")
        return MihomoConfigSnapshot(content = content)
    }

    override suspend fun validate(baseUrl: String, content: String): MihomoValidationResult {
        val response = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/mihomo/validate_raw",
                body = JSONObject().put("config", content).toString(),
            ),
        )
        val root = response.requireJsonObject("Xkeen UI вернул неожиданный ответ проверки YAML.")
        return MihomoValidationResult(
            valid = root.optBoolean("ok", false),
            log = root.optString("log").trim(),
        )
    }

    override suspend fun save(
        baseUrl: String,
        content: String,
        restart: Boolean,
    ): MihomoConfigSnapshot {
        val endpoint = if (restart) "/api/mihomo/restart_raw" else "/api/mihomo/save_raw"
        val response = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = endpoint,
                body = JSONObject().put("config", content).toString(),
            ),
        )
        val root = response.requireJsonObject("Xkeen UI вернул неожиданный ответ сохранения YAML.")
        if (!root.optBoolean("ok", false)) {
            throw MihomoConfigException(
                root.optString("error").trim().ifBlank { "Xkeen UI не подтвердил сохранение config.yaml." },
            )
        }
        return MihomoConfigSnapshot(
            // Both raw endpoints call rstrip() before writing; mirror the server-authoritative text.
            content = content.trimEnd(),
            activeProfile = root.optString("active_profile").trim().ifBlank { "config.yaml" },
        )
    }
}

internal class MihomoConfigException(message: String) : Exception(message)

private fun CompanionHttpResponse.requireJsonObject(message: String): JSONObject = try {
    JSONObject(body)
} catch (error: Exception) {
    throw MihomoConfigException(message)
}
