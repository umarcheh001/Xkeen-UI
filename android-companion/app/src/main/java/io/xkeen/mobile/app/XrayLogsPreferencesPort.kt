package io.xkeen.mobile.app

import android.content.Context
import android.content.SharedPreferences

private const val XRAY_LOGS_PREFERENCES_NAME = "xkeen_mobile_xray_logs"
private const val KEY_HAS_SAVED_PREFERENCES = "has_saved_preferences"
private const val KEY_STREAM_FILTER = "stream_filter"
private const val KEY_LEVEL_FILTER = "level_filter"
private const val KEY_SEARCH_QUERY = "search_query"
private const val KEY_USE_REGEX = "use_regex"
private const val KEY_DISPLAY_LIMIT = "display_limit"
private const val KEY_COMPACT_ROWS = "compact_rows"
private const val KEY_FOLLOW_NEWEST = "follow_newest"
private const val KEY_PAUSED_BY_USER = "paused_by_user"
private const val KEY_SHOW_DEVICE_NAMES = "show_device_names"
private const val KEY_SHOW_DOMAINS = "show_domains"

private const val DEFAULT_DISPLAY_LIMIT = 600
private const val MIN_DISPLAY_LIMIT = 50
private const val MAX_SEARCH_QUERY_LENGTH = 240

internal data class XrayLogsPreferences(
    val streamFilter: XrayLogStreamFilter = XrayLogStreamFilter.Access,
    val levelFilter: XrayLogLevelFilter = XrayLogLevelFilter.All,
    val searchQuery: String = "",
    val useRegex: Boolean = false,
    val displayLimit: Int = DEFAULT_DISPLAY_LIMIT,
    val compactRows: Boolean = true,
    val followNewest: Boolean = true,
    val isPausedByUser: Boolean = false,
    val showDeviceNames: Boolean = true,
    val showDomains: Boolean = true,
)

internal interface XrayLogsPreferencesPort {
    fun load(): XrayLogsPreferences?

    fun save(preferences: XrayLogsPreferences)
}

internal class InMemoryXrayLogsPreferencesPort(
    initial: XrayLogsPreferences? = null,
) : XrayLogsPreferencesPort {
    private var stored = initial

    override fun load(): XrayLogsPreferences? = stored

    override fun save(preferences: XrayLogsPreferences) {
        stored = preferences
    }
}

internal class SharedPreferencesXrayLogsPreferencesPort(
    context: Context,
) : XrayLogsPreferencesPort {
    private val preferences = context.applicationContext.getSharedPreferences(
        XRAY_LOGS_PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    override fun load(): XrayLogsPreferences? {
        if (!preferences.safeBoolean(KEY_HAS_SAVED_PREFERENCES, false)) return null
        return XrayLogsPreferences(
            streamFilter = preferences.safeEnum(KEY_STREAM_FILTER, XrayLogStreamFilter.Access),
            levelFilter = preferences.safeEnum(KEY_LEVEL_FILTER, XrayLogLevelFilter.All),
            searchQuery = preferences.safeString(KEY_SEARCH_QUERY, "").take(MAX_SEARCH_QUERY_LENGTH),
            useRegex = preferences.safeBoolean(KEY_USE_REGEX, false),
            displayLimit = preferences.safeInt(KEY_DISPLAY_LIMIT, DEFAULT_DISPLAY_LIMIT)
                .coerceIn(MIN_DISPLAY_LIMIT, DEFAULT_DISPLAY_LIMIT),
            compactRows = preferences.safeBoolean(KEY_COMPACT_ROWS, true),
            followNewest = preferences.safeBoolean(KEY_FOLLOW_NEWEST, true),
            isPausedByUser = preferences.safeBoolean(KEY_PAUSED_BY_USER, false),
            showDeviceNames = preferences.safeBoolean(KEY_SHOW_DEVICE_NAMES, true),
            showDomains = preferences.safeBoolean(KEY_SHOW_DOMAINS, true),
        )
    }

    override fun save(preferences: XrayLogsPreferences) {
        this.preferences.edit()
            .putBoolean(KEY_HAS_SAVED_PREFERENCES, true)
            .putString(KEY_STREAM_FILTER, preferences.streamFilter.name)
            .putString(KEY_LEVEL_FILTER, preferences.levelFilter.name)
            .putString(KEY_SEARCH_QUERY, preferences.searchQuery.take(MAX_SEARCH_QUERY_LENGTH))
            .putBoolean(KEY_USE_REGEX, preferences.useRegex)
            .putInt(
                KEY_DISPLAY_LIMIT,
                preferences.displayLimit.coerceIn(MIN_DISPLAY_LIMIT, DEFAULT_DISPLAY_LIMIT),
            )
            .putBoolean(KEY_COMPACT_ROWS, preferences.compactRows)
            .putBoolean(KEY_FOLLOW_NEWEST, preferences.followNewest)
            .putBoolean(KEY_PAUSED_BY_USER, preferences.isPausedByUser)
            .putBoolean(KEY_SHOW_DEVICE_NAMES, preferences.showDeviceNames)
            .putBoolean(KEY_SHOW_DOMAINS, preferences.showDomains)
            .apply()
    }
}

internal fun persistedXrayLogsPreferencesPort(context: Context): XrayLogsPreferencesPort =
    SharedPreferencesXrayLogsPreferencesPort(context)

internal fun LogsState.withXrayLogsPreferences(preferences: XrayLogsPreferences): LogsState = copy(
    streamFilter = preferences.streamFilter,
    levelFilter = preferences.levelFilter,
    searchQuery = preferences.searchQuery.take(MAX_SEARCH_QUERY_LENGTH),
    useRegex = preferences.useRegex,
    displayLimit = preferences.displayLimit.coerceIn(MIN_DISPLAY_LIMIT, DEFAULT_DISPLAY_LIMIT),
    compactRows = preferences.compactRows,
    followNewest = preferences.followNewest,
    isPausedByUser = preferences.isPausedByUser,
    showDeviceNames = preferences.showDeviceNames,
    showDomains = preferences.showDomains,
)

internal fun LogsState.toXrayLogsPreferences(): XrayLogsPreferences = XrayLogsPreferences(
    streamFilter = streamFilter,
    levelFilter = levelFilter,
    searchQuery = searchQuery.take(MAX_SEARCH_QUERY_LENGTH),
    useRegex = useRegex,
    displayLimit = displayLimit.coerceIn(MIN_DISPLAY_LIMIT, DEFAULT_DISPLAY_LIMIT),
    compactRows = compactRows,
    followNewest = followNewest,
    isPausedByUser = isPausedByUser,
    showDeviceNames = showDeviceNames,
    showDomains = showDomains,
)

private inline fun <reified T : Enum<T>> SharedPreferences.safeEnum(key: String, fallback: T): T =
    runCatching { getString(key, null) }
        .getOrNull()
        ?.let { stored -> enumValues<T>().firstOrNull { it.name == stored } }
        ?: fallback

private fun SharedPreferences.safeString(key: String, fallback: String): String =
    runCatching { getString(key, fallback) }.getOrNull() ?: fallback

private fun SharedPreferences.safeBoolean(key: String, fallback: Boolean): Boolean =
    runCatching { getBoolean(key, fallback) }.getOrDefault(fallback)

private fun SharedPreferences.safeInt(key: String, fallback: Int): Int =
    runCatching { getInt(key, fallback) }.getOrDefault(fallback)
