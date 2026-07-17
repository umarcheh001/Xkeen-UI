package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class XrayDatPortTest {
    private val file = XrayDatFile(
        kind = XrayDatKind.GeoSite,
        name = "geosite_v2fly.dat",
        path = "/opt/etc/xray/dat/geosite_v2fly.dat",
    )

    @Test
    fun directoryParserKeepsOnlyRecognizedGeoFilesAndLinks() {
        val files = parseXrayDatDirectory(
            """{
                "ok": true,
                "path": "/opt/etc/xray/dat",
                "items": [
                    {"name":"geosite_v2fly.dat","type":"file","size":2254112,"mtime":1721000000},
                    {"name":"zkeen.dat","type":"link","size":1410048},
                    {"name":"geoip_v2fly.dat","type":"file","size":408678},
                    {"name":"zkeenip.dat","type":"file","size":399104},
                    {"name":"custom.dat","type":"file"},
                    {"name":"geosite-folder.dat","type":"dir"}
                ]
            }""",
        )

        assertEquals(
            listOf("geosite_v2fly.dat", "zkeen.dat", "geoip_v2fly.dat", "zkeenip.dat"),
            files.map(XrayDatFile::name),
        )
        assertEquals(listOf(XrayDatKind.GeoSite, XrayDatKind.GeoSite, XrayDatKind.GeoIp, XrayDatKind.GeoIp), files.map(XrayDatFile::kind))
        assertEquals(2_254_112L, files.first().sizeBytes)
    }

    @Test
    fun parsesTagsPagesSearchAndLookupVariants() {
        val tags = parseXrayDatTags(
            """{"ok":true,"tags":[{"tag":"DISCORD","count":40},{"t":"GITHUB","c":28},"GOOGLE"]}""",
            file,
        )
        val page = parseXrayDatItemsPage(
            """{"ok":true,"tag":"DISCORD","offset":100,"limit":100,"total":240,"items":[{"t":"domain","v":"discord.com"},"discord.gg"]}""",
            file,
        )
        val search = parseXrayDatSearchPage(
            """{"ok":true,"tag":"DISCORD","q":"app","cursor":0,"next_cursor":200,"viewed":200,"total":240,"mode":"contains","items":[{"type":"domain","value":"discordapp.com"}]}""",
            file,
        )
        val lookup = parseXrayDatLookupResult(
            """{"ok":true,"value":"discord.com","matches":[{"tag":"DISCORD","count":40}]}""",
            file,
        )

        assertEquals(listOf("DISCORD", "GITHUB", "GOOGLE"), tags.tags.map(XrayDatTag::name))
        assertEquals(100, page.offset)
        assertEquals(240, page.total)
        assertEquals(listOf("discord.com", "discord.gg"), page.items.map(XrayDatItem::value))
        assertEquals(200, search.nextCursor)
        assertEquals("discordapp.com", search.items.single().value)
        assertEquals("DISCORD", lookup.matches.single().name)
    }

    @Test
    fun missingGeodatMessageIsMobileReadOnlyGuidance() {
        val error = runCatching {
            parseXrayDatTags(
                """{"ok":false,"error":"missing_xk_geodat"}""",
                file,
            )
        }.exceptionOrNull()

        assertTrue(error is XrayDatException)
        assertTrue(error?.message.orEmpty().contains("веб-панель"))
    }

    @Test
    fun productionPortUsesOnlyReadEndpointsForCatalogAndBrowsing() = runTest {
        val transport = QueueXrayDatTransport(
            getResponses = listOf(
                datResponse("""{"ok":true,"installed":true}"""),
                datResponse("""{"ok":true,"path":"/opt/etc/xray/dat","items":[{"name":"geosite.dat","type":"file"}]}"""),
                datResponse("""{"ok":true,"path":"/opt/etc/xray","items":[]}"""),
                datResponse("""{"ok":true,"tags":[{"tag":"DISCORD","count":40}]}"""),
                datResponse("""{"ok":true,"tag":"DISCORD","offset":0,"limit":100,"items":[{"t":"domain","v":"discord.com"}],"total":1}"""),
            ),
            postResponses = listOf(
                datResponse("""{"ok":true,"value":"discord.com","matches":[{"tag":"DISCORD"}]}"""),
            ),
        )
        val port = WebPanelXrayDatPort(transport)

        val catalog = port.loadCatalog("https://router.example")
        val selected = catalog.files.single()
        port.loadTags("https://router.example", selected)
        port.loadTagPage("https://router.example", selected, "DISCORD", 0, 100)
        port.lookupValue("https://router.example", selected, "discord.com")

        assertTrue(catalog.geodatInstalled == true)
        assertEquals(
            listOf(
                "/api/routing/geodat/status",
                "/api/fs/list?target=local&path=%2Fopt%2Fetc%2Fxray%2Fdat",
                "/api/fs/list?target=local&path=%2Fopt%2Fetc%2Fxray",
                "/api/routing/dat/tags?kind=geosite&path=%2Fopt%2Fetc%2Fxray%2Fdat%2Fgeosite.dat",
                "/api/routing/dat/tag?kind=geosite&path=%2Fopt%2Fetc%2Fxray%2Fdat%2Fgeosite.dat&tag=DISCORD&offset=0&limit=100",
            ),
            transport.getRequests.map(CompanionHttpRequest::endpoint),
        )
        assertEquals(listOf("/api/routing/dat/lookup"), transport.postRequests.map(CompanionHttpRequest::endpoint))
        assertTrue(transport.postRequests.single().body.orEmpty().contains("\"value\":\"discord.com\""))
        assertTrue(transport.deleteRequests.isEmpty())
    }

    @Test
    fun stateFiltersTagsAndComputesPagingWithoutMutations() {
        val state = XrayDatState(
            tags = listOf(XrayDatTag("DISCORD"), XrayDatTag("GITHUB")),
            tagQuery = "disc",
            items = List(100) { XrayDatItem("domain", "item-$it") },
            itemOffset = 100,
            itemLimit = 100,
            itemTotal = 250,
        )

        assertEquals(listOf("DISCORD"), state.visibleTags.map(XrayDatTag::name))
        assertTrue(state.canLoadPreviousPage)
        assertTrue(state.canLoadNextPage)
        assertFalse(state.isItemSearch)
        assertNull(state.lookupMatches)
    }
}

private class QueueXrayDatTransport(
    getResponses: List<CompanionHttpResponse> = emptyList(),
    postResponses: List<CompanionHttpResponse> = emptyList(),
) : CompanionHttpTransport {
    private val gets = java.util.ArrayDeque(getResponses)
    private val posts = java.util.ArrayDeque(postResponses)
    val getRequests = mutableListOf<CompanionHttpRequest>()
    val postRequests = mutableListOf<CompanionHttpRequest>()
    val deleteRequests = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse {
        getRequests += request
        return gets.removeFirst()
    }

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse {
        postRequests += request
        return posts.removeFirst()
    }

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse {
        deleteRequests += request
        error("DAT viewer must not use DELETE")
    }
}

private fun datResponse(body: String) = CompanionHttpResponse(
    statusCode = 200,
    body = body,
    headers = emptyMap(),
    contentType = "application/json",
)
