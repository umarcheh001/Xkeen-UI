package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class XrayLogEnrichmentTest {
    @Test
    fun `resolver correlates sniffed domain and destination ip by connection id`() {
        val resolver = XrayLogDomainResolver()
        val entries = listOf(
            log("18:00:00", "2026/07/20 18:00:00 [Info] [312345] sniffed domain: cdn.example.com"),
            log("18:00:00", "2026/07/20 18:00:00 [Info] [312345] dialing tcp to tcp:203.0.113.7:443"),
        )

        val domains = resolver.ingest(entries)

        assertEquals("cdn.example.com", domains["203.0.113.7"])
    }

    @Test
    fun `proxy endpoint dial is not mistaken for requested domain`() {
        val candidates = collectXrayLogDomainCandidates(
            "2026/07/20 18:00:00 [Info] [312345] transport/internet/tcp: dialing TCP to tcp:proxy.example.net:443",
        )

        assertTrue(candidates.isEmpty())
    }

    @Test
    fun `inline hints place device by lan ip and dns only by destination ip`() {
        val message = "from 192.168.1.83:49483 accepted tcp:203.0.113.7:443 [direct]"
        val hints = xrayLogInlineHints(
            displayMessage = message,
            devicesByIp = mapOf("192.168.1.83" to XrayLogDevice("192.168.1.83", "umar-pc", "router")),
            domainsByIp = mapOf("203.0.113.7" to "cdn.example.com"),
            showDeviceNames = true,
            showDomains = true,
        )

        assertEquals(listOf("umar-pc", "dns cdn.example.com"), hints.map(XrayLogInlineHint::label))
        assertEquals(XrayLogInlineHintKind.Device, hints.first().kind)
        assertEquals(XrayLogInlineHintKind.Domain, hints.last().kind)
    }

    @Test
    fun `search matches visible device and dns enrichment`() {
        val entry = LogEntry(
            time = "18:00:00",
            source = "xray-access",
            level = LogLevel.Info,
            message = "2026/07/20 18:00:00 from 192.168.1.83:49483 accepted tcp:203.0.113.7:443",
            id = "access:1",
        )
        val base = LogsState(
            entries = listOf(entry),
            devices = listOf(XrayLogDevice("192.168.1.83", "umar-pc", "router")),
            destinationDomainsByIp = mapOf("203.0.113.7" to "cdn.example.com"),
        )

        assertEquals(listOf(entry), base.copy(searchQuery = "umar-pc").projectXrayLogs().entries)
        assertEquals(listOf(entry), base.copy(searchQuery = "cdn.example.com").projectXrayLogs().entries)
    }

    @Test
    fun `normalizers reject ip and proxy file names as domains`() {
        assertEquals("192.168.1.83", normalizeXrayLogIp("192.168.001.083"))
        assertEquals("", normalizeXrayLogIp("999.168.1.1"))
        assertEquals("example.com", normalizeXrayLogDomain("https://Example.COM:443/path"))
        assertEquals("", normalizeXrayLogDomain("error.log"))
        assertEquals("", normalizeXrayLogDomain("203.0.113.7"))
    }
}

private fun log(time: String, message: String): LogEntry = LogEntry(
    time = time,
    source = "xray-error",
    level = LogLevel.Info,
    message = message,
    id = message.hashCode().toString(),
)
