package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class XraySubscriptionsPortTest {
    @Test
    fun listMapsSubscriptionDiagnosticsAndGeneratedNodes() {
        val snapshot = parseXraySubscriptionsSnapshot(
            """
                {
                  "ok": true,
                  "subscriptions": [{
                    "id":"cdn","name":"CDN","tag":"cdn.example","url":"https://cdn.example/sub",
                    "enabled":true,"ping_enabled":false,"routing_mode":"subscription-only",
                    "routing_auto_rule":true,"routing_balancer_tags":["proxy"],"sockopt_mark_255":true,
                    "interval_hours":12,"output_file":"04_outbounds.cdn.json",
                    "name_filter":"NL|DE","type_filter":"vless","transport_filter":"xhttp",
                    "excluded_node_keys":["hidden"],"last_ok":false,"last_error":"provider failed",
                    "last_update_ts":100.9,"next_update_ts":200.1,"last_count":1,
                    "last_source_count":2,"last_filtered_out_count":1,
                    "last_warnings":["gRPC deprecated"],
                    "last_errors":[{"idx":0,"tag":"cdn--nl","error":"invalid link"}],
                    "last_source_format":"links","last_fetch_mode":"direct",
                    "profile_update_interval_hours":6,
                    "node_latency":{"node-nl":{"status":"ok","delay_ms":47}},
                    "last_nodes":[
                      {"key":"node-nl","tag":"cdn--nl","name":"Amsterdam","protocol":"vless",
                       "transport":"xhttp","security":"reality","host":"nl.example","port":443,"sni":"cdn.example"},
                      {"key":"hidden","name":"Hidden","protocol":"trojan","host":"de.example","port":"443"}
                    ]
                  }],
                  "routing_balancers":[{"tag":"proxy","strategy_type":"leastPing","selector_count":2,"auto_managed":true}],
                  "routing_meta":{"existing_auto_balancer_tag":"proxy","auto_balancer_candidate_tag":"xk-subscriptions-proxy"}
                }
            """.trimIndent(),
        )

        val record = snapshot.subscriptions.single()
        assertEquals("cdn", record.id)
        assertFalse(record.pingEnabled)
        assertEquals("subscription-only", record.routingMode)
        assertTrue(record.sockoptMark255)
        assertEquals(100L, record.lastUpdateEpochSeconds)
        assertEquals("provider failed", record.lastError)
        assertEquals(listOf("#1 · cdn--nl: invalid link"), record.errors)
        assertEquals(2, record.nodes.size)
        assertEquals(47L, record.nodes.first().latency?.delayMillis)
        assertEquals("", record.nodes[1].tag)
        assertEquals("proxy", snapshot.routingBalancers.single().tag)
        assertEquals("proxy", snapshot.existingAutoBalancerTag)
    }

    @Test
    fun previewMapsCountsWarningsAndNodes() {
        val preview = parseXraySubscriptionPreview(
            """
                {"ok":true,"count":1,"source_count":2,"filtered_out_count":1,
                 "warnings":["HWID warning"],"errors":[],"source_format":"links","fetch_mode":"hwid",
                 "profile_update_interval_hours":24,"tag_prefix":"cdn",
                 "nodes":[{"key":"one","tag":"cdn--one","name":"One","protocol":"vless","port":443},
                          {"key":"two","name":"Two","protocol":"trojan","port":8443}]}
            """.trimIndent(),
        )

        assertEquals(1, preview.count)
        assertEquals(2, preview.sourceCount)
        assertEquals(1, preview.filteredOutCount)
        assertEquals("hwid", preview.fetchMode)
        assertEquals(2, preview.nodes.size)
        assertEquals("", preview.nodes.last().tag)
    }

    @Test
    fun webPortUsesExactEndpointsAndPayloads() = runTest {
        val transport = RecordingSubscriptionsTransport(
            getResponses = ArrayDeque(listOf(response("""{"ok":true,"subscriptions":[],"routing_balancers":[],"routing_meta":{}}"""))),
            postResponses = ArrayDeque(
                listOf(
                    response("""{"ok":true,"nodes":[],"count":0,"source_count":0,"filtered_out_count":0}"""),
                    response("""{"ok":true,"subscription":{"id":"cdn","name":"CDN","tag":"cdn","url":"https://cdn.example/sub","enabled":true,"ping_enabled":true,"routing_auto_rule":true,"routing_mode":"safe-fallback","interval_hours":24,"output_file":"04_outbounds.cdn.json"}}"""),
                    response("""{"ok":true,"id":"cdn","changed":true,"count":2,"output_file":"04_outbounds.cdn.json","restarted":false}"""),
                    response("""{"ok":true,"updated":1,"ok_count":0,"results":[{"id":"cdn","ok":false,"error":"timeout","next_update_ts":900}]}"""),
                ),
            ),
            deleteResponses = ArrayDeque(
                listOf(
                    response("""{"ok":true,"deleted":{"id":"cdn","name":"CDN","tag":"cdn","url":"https://cdn.example/sub","enabled":true,"ping_enabled":true,"routing_auto_rule":true,"routing_mode":"safe-fallback","interval_hours":24,"output_file":"04_outbounds.cdn.json"},"output_removed":true,"restarted":true}"""),
                ),
            ),
        )
        val port = WebPanelXraySubscriptionsPort(transport)
        val request = XraySubscriptionSaveRequest(
            name = " CDN ",
            tag = " cdn ",
            url = " https://cdn.example/sub ",
            excludedNodeKeys = listOf(" hidden "),
            pingEnabled = false,
            routingMode = "subscription-only",
            routingBalancerTags = listOf(" proxy "),
            sockoptMark255 = true,
            intervalHours = 999,
        )

        port.list("https://router.lan")
        port.preview("https://router.lan", request)
        val saved = port.upsert("https://router.lan", request)
        val refreshed = port.refresh("https://router.lan", "cdn name", restart = false)
        val due = port.refreshDue("https://router.lan", restart = true)
        val deleted = port.delete("https://router.lan", "cdn name", restart = true)

        assertEquals("/api/xray/subscriptions", transport.gets.single().endpoint)
        assertEquals("/api/xray/subscriptions/preview", transport.posts[0].endpoint)
        val previewBody = JSONObject(transport.posts[0].body.orEmpty())
        assertFalse(previewBody.has("enabled"))
        assertEquals("hidden", previewBody.getJSONArray("excluded_node_keys").getString(0))
        val saveBody = JSONObject(transport.posts[1].body.orEmpty())
        assertEquals(168, saveBody.getInt("interval_hours"))
        assertFalse(saveBody.getBoolean("ping_enabled"))
        assertTrue(saveBody.getBoolean("sockopt_mark_255"))
        assertEquals("/api/xray/subscriptions/cdn+name/refresh?restart=0", transport.posts[2].endpoint)
        assertEquals("/api/xray/subscriptions/refresh-due?restart=1", transport.posts[3].endpoint)
        assertEquals("/api/xray/subscriptions/cdn+name?restart=1&remove_file=1", transport.deletes.single().endpoint)
        assertEquals("cdn", saved.subscription?.id)
        assertTrue(refreshed.generatedChanged)
        assertFalse(refreshed.restarted)
        assertEquals("timeout", due.results.single().error)
        assertTrue(deleted.generatedChanged)
        assertTrue(deleted.restarted)
    }

    @Test
    fun dueParserKeepsPartialFailuresWithoutThrowing() {
        val result = parseXraySubscriptionsDueResult(
            """{"ok":true,"updated":2,"ok_count":1,"results":[
                {"id":"one","ok":true,"changed":false,"count":2},
                {"id":"two","ok":false,"error":"blocked"}
            ]}""",
        )

        assertEquals(2, result.updated)
        assertEquals(1, result.okCount)
        assertTrue(result.results.first().ok)
        assertFalse(result.results.last().ok)
        assertEquals("blocked", result.results.last().error)
    }

    @Test
    fun subscriptionBulkPingUsesAsyncJobAndKeepsPartialResults() = runTest {
        val transport = RecordingSubscriptionsTransport(
            getResponses = ArrayDeque(
                listOf(
                    response("""{"ok":true,"job_id":"job-1","status":"running"}"""),
                    response(
                        """{"ok":true,"job_id":"job-1","status":"finished","result":{
                            "ok":false,"requested":2,"updated":2,"ok_count":1,"failed_count":1,
                            "results":[
                              {"ok":true,"node_key":"node-1","entry":{"status":"ok","delay_ms":51}},
                              {"ok":false,"node_key":"node-2","error":"timeout"}
                            ]
                        }}""",
                    ),
                ),
            ),
            postResponses = ArrayDeque(
                listOf(response("""{"ok":true,"async":true,"job_id":"job-1","status":"queued"}""")),
            ),
            deleteResponses = ArrayDeque(),
        )
        val port = WebPanelXraySubscriptionsPort(transport)

        val result = port.pingNodes(
            baseUrl = "https://router.lan",
            id = "provider name",
            nodeKeys = listOf("node-1", "node-2", "node-1"),
        )

        assertEquals(2, result.requested)
        assertEquals(1, result.okCount)
        assertEquals(1, result.failedCount)
        assertEquals(51L, result.latencyByNodeKey["node-1"]?.delayMillis)
        assertEquals("error", result.latencyByNodeKey["node-2"]?.status)
        assertEquals("timeout", result.latencyByNodeKey["node-2"]?.message)
        assertEquals(
            "/api/xray/subscriptions/provider+name/nodes/ping-bulk",
            transport.posts.single().endpoint,
        )
        val body = JSONObject(transport.posts.single().body.orEmpty())
        assertTrue(body.getBoolean("async"))
        assertEquals(2, body.getJSONArray("node_keys").length())
        assertEquals(
            listOf("/api/xray/latency-jobs/job-1", "/api/xray/latency-jobs/job-1"),
            transport.gets.map(CompanionHttpRequest::endpoint),
        )
    }

    @Test
    fun nullableStatusFieldsStayNullWhenBackendHasNoRefreshYet() {
        val snapshot = parseXraySubscriptionsSnapshot(
            """{"ok":true,"subscriptions":[{"id":"new","name":"New","tag":"new","url":"https://example/sub","enabled":true,"ping_enabled":true,"routing_auto_rule":true,"routing_mode":"safe-fallback","interval_hours":24,"output_file":"04_outbounds.new.json"}]}""",
        )

        assertNull(snapshot.subscriptions.single().lastOk)
        assertNull(snapshot.subscriptions.single().lastUpdateEpochSeconds)
    }
}

private fun response(body: String) = CompanionHttpResponse(
    statusCode = 200,
    body = body,
    headers = emptyMap(),
    contentType = "application/json",
)

private class RecordingSubscriptionsTransport(
    private val getResponses: ArrayDeque<CompanionHttpResponse>,
    private val postResponses: ArrayDeque<CompanionHttpResponse>,
    private val deleteResponses: ArrayDeque<CompanionHttpResponse>,
) : CompanionHttpTransport {
    val gets = mutableListOf<CompanionHttpRequest>()
    val posts = mutableListOf<CompanionHttpRequest>()
    val deletes = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse {
        gets += request
        return getResponses.removeFirst()
    }

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse {
        posts += request
        return postResponses.removeFirst()
    }

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse {
        deletes += request
        return deleteResponses.removeFirst()
    }
}
