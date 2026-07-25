package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class XrayLogsProjectionTest {
    @Test
    fun `jump to newest button is shown only while scrolled away from followed tail`() {
        assertFalse(shouldShowXrayLogsJumpToNewest(followNewest = true, canScrollForward = true))
        assertFalse(shouldShowXrayLogsJumpToNewest(followNewest = false, canScrollForward = false))
        assertTrue(shouldShowXrayLogsJumpToNewest(followNewest = false, canScrollForward = true))
    }

    @Test
    fun `level filters are cumulative thresholds for error log`() {
        val entries = listOf(
            LogEntry("18:00:01", "xray-error", LogLevel.Debug, "2026/07/16 18:00:01 debug", "debug"),
            LogEntry("18:00:02", "xray-error", LogLevel.Info, "2026/07/16 18:00:02 info", "info"),
            LogEntry("18:00:03", "xray-error", LogLevel.Warning, "2026/07/16 18:00:03 warning", "warning"),
            LogEntry("18:00:04", "xray-error", LogLevel.Error, "2026/07/16 18:00:04 error", "error"),
            // The level is deliberately noisy: access.log must not participate in the threshold.
            LogEntry("18:00:05", "xray-access", LogLevel.Error, "2026/07/16 18:00:05 accepted tcp", "access"),
        )

        fun ids(filter: XrayLogLevelFilter, stream: XrayLogStreamFilter = XrayLogStreamFilter.All) =
            LogsState(entries = entries, streamFilter = stream, levelFilter = filter)
                .projectXrayLogs().entries.map(LogEntry::id)

        assertEquals(listOf("debug", "info", "warning", "error", "access"), ids(XrayLogLevelFilter.All))
        assertEquals(listOf("debug", "info", "warning", "error", "access"), ids(XrayLogLevelFilter.Debug))
        assertEquals(listOf("info", "warning", "error", "access"), ids(XrayLogLevelFilter.Info))
        assertEquals(listOf("warning", "error", "access"), ids(XrayLogLevelFilter.Warning))
        assertEquals(listOf("error", "access"), ids(XrayLogLevelFilter.Error))
        assertEquals(listOf("access"), ids(XrayLogLevelFilter.Error, XrayLogStreamFilter.Access))
    }

    @Test
    fun `projection keeps only Xray entries and merges streams chronologically`() {
        val projection = LogsState(entries = sampleEntries).projectXrayLogs()

        assertEquals(4, projection.totalXrayEntries)
        assertEquals(
            listOf("connected", "failed to resolve", "accepted tcp:example.org:443", "route warning"),
            projection.entries.map(LogEntry::displayMessage),
        )
        assertTrue(projection.entries.none { it.source == "service" })
    }

    @Test
    fun `source severity and literal search filters compose`() {
        val projection = LogsState(
            entries = sampleEntries,
            streamFilter = XrayLogStreamFilter.Error,
            levelFilter = XrayLogLevelFilter.Warning,
            searchQuery = "ROUTE",
        ).projectXrayLogs()

        assertEquals(listOf("route warning"), projection.entries.map(LogEntry::displayMessage))
    }

    @Test
    fun `regex search reports invalid expression without throwing`() {
        val valid = LogsState(
            entries = sampleEntries,
            searchQuery = "accepted.*443",
            useRegex = true,
        ).projectXrayLogs()
        val invalid = LogsState(
            entries = sampleEntries,
            searchQuery = "[",
            useRegex = true,
        ).projectXrayLogs()

        assertEquals(1, valid.entries.size)
        assertTrue(invalid.entries.isEmpty())
        assertNotNull(invalid.regexError)
    }

    @Test
    fun `linear regex engine safely handles nested quantifiers`() {
        val projection = LogsState(
            entries = sampleEntries,
            searchQuery = "(a+)+$",
            useRegex = true,
        ).projectXrayLogs()

        assertTrue(projection.entries.isEmpty())
        assertEquals(null, projection.regexError)
    }

    @Test
    fun `merged streams keep full date order across midnight`() {
        val entries = listOf(
            LogEntry("00:00:01", "xray-access", LogLevel.Info, "2026/07/17 00:00:01 next day", "access:2"),
            LogEntry("23:59:59", "xray-error", LogLevel.Error, "2026/07/16 23:59:59 previous day", "error:1"),
        )

        val projection = LogsState(entries = entries).projectXrayLogs()

        assertEquals(listOf("previous day", "next day"), projection.entries.map(LogEntry::displayMessage))
    }

    @Test
    fun `literal search keeps adjacent multiline access context`() {
        val entries = listOf(
            LogEntry("18:10:00", "xray-access", LogLevel.Info, "2026/07/16 18:10:00 accepted tcp:client -> example.org:443", "access:1"),
            LogEntry("18:10:00", "xray-access", LogLevel.Info, "  route: proxy -> cloud-eu", "access:2"),
            LogEntry("18:10:01", "xray-access", LogLevel.Info, "2026/07/16 18:10:01 accepted tcp:client -> other.org:443", "access:3"),
        )

        val projection = LogsState(
            entries = entries,
            searchQuery = "example.org",
        ).projectXrayLogs()

        assertEquals(
            listOf("accepted tcp:client -> example.org:443", "↳ route: proxy -> cloud-eu"),
            projection.entries.map(LogEntry::displayMessage),
        )
    }

    @Test
    fun `severity filter keeps multiline context inherited from error`() {
        val entries = listOf(
            LogEntry("18:10:00", "xray-error", LogLevel.Error, "  transport: grpc", "error:2"),
            LogEntry("18:10:00", "xray-error", LogLevel.Error, "2026/07/16 18:10:00 [Error] failed to dial", "error:1"),
        )

        val projection = LogsState(
            entries = entries,
            levelFilter = XrayLogLevelFilter.Error,
        ).projectXrayLogs()

        assertEquals(
            listOf("[Error] failed to dial", "↳ transport: grpc"),
            projection.entries.map(LogEntry::displayMessage),
        )
    }

    @Test
    fun `local journal records no longer truncate remote history to twenty rows`() {
        val remote = (0 until 600).map { index ->
            LogEntry(
                id = "error:$index",
                time = "18:00:00",
                source = "xray-error",
                level = LogLevel.Info,
                message = "remote $index",
            )
        }
        val updated = DemoLogsPort(FixedJournal).record(
            current = LogsState(displayLimit = 600, entries = remote),
            source = "service",
            level = LogLevel.Info,
            message = "local event",
        )

        assertEquals(601, updated.entries.size)
        assertEquals("local event", updated.entries.first().message)
        assertEquals(600, updated.entries.count { it.source == "xray-error" })
    }

    @Test
    fun `unseen counter still works after capped buffer evicts last seen row`() {
        val entries = (101..600).map { index ->
            LogEntry("18:00:00", "xray-access", LogLevel.Info, "line $index", "access:$index")
        }

        assertEquals(10, entries.unseenXrayEntriesAfter("access:590"))
        assertEquals(500, entries.unseenXrayEntriesAfter("access:100"))
    }

    @Test
    fun `clipboard payload stays bounded and prefers newest complete rows`() {
        val entries = (1..20).map { index ->
            LogEntry("18:00:00", "xray-access", LogLevel.Info, "$index:${"x".repeat(500)}", "access:$index")
        }

        val payload = entries.toXrayLogsClipboardPayload(maxChars = 2_100)

        assertTrue(payload.text.length <= 2_100)
        assertEquals(4, payload.entryCount)
        assertEquals(20, payload.totalEntries)
        assertTrue(payload.text.contains("20:"))
        assertTrue(payload.text.startsWith("17:"))
    }

    private companion object {
        val sampleEntries = listOf(
            LogEntry("18:01:04", "xray-access", LogLevel.Info, "2026/07/16 18:01:04 accepted tcp:example.org:443", "access:2"),
            LogEntry("18:01:05", "service", LogLevel.Info, "service event", ""),
            LogEntry("18:01:03", "xray-error", LogLevel.Error, "2026/07/16 18:01:03 failed to resolve", "error:1"),
            LogEntry("18:01:06", "xray-error", LogLevel.Warning, "2026/07/16 18:01:06 route warning", "error:2"),
            LogEntry("18:01:01", "xray-access", LogLevel.Info, "2026/07/16 18:01:01 connected", "access:1"),
        )

        object FixedJournal : CompanionJournalPort {
            override fun shortTime(): String = "18:02"

            override fun longTime(): String = "18:02:00"
        }
    }
}
