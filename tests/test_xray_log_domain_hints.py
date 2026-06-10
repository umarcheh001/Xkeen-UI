from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_domain_hints_probe(script: str):
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


def test_xray_log_domain_hints_extract_destinations_and_domains():
    data = run_domain_hints_probe(
        """
        import {
          collectXrayLogDestinationIpPorts,
          collectXrayLogDomainCandidates,
          extractXrayLogConnectionId,
          normalizeXrayLogDomain,
        } from './xkeen-ui/static/js/features/xray_log_domain_hints.js';

        const access = '2026/06/08 15:07:50 from 192.168.1.83:51158 accepted tcp:8.6.112.0:443 [redirect -> direct]';
        const sniffed = '2026/06/08 15:08:01 [INFO] [3868264735] app/dispatcher: sniffed domain: ab.chatgpt.com';
        const route = '2026/06/08 15:08:01 [INFO] [3868264735] app/dispatcher: Hit route rule: [xk_auto] for [tcp:ab.chatgpt.com:443]';
        const tunProcessing = '2026/06/06 23:38:25.092182 [Info] [1744767180] proxy/tun: processing from tcp:10.0.0.1:55765 to tcp:110.242.74.102:80';
        const directDial = '2026/06/06 23:38:25.095597 [Info] [1744767180] transport/internet/tcp: dialing TCP to tcp:110.242.74.102:80';
        const outboundEndpointDial = '2026/06/10 09:24:27.220660 [Info] [2779876993] transport/internet/tcp: dialing TCP to tcp:cp.landing-lv.rfid-technologies.org:443';
        const outboundTunnelViaEndpoint = '2026/06/10 09:24:27.220660 [Info] [2779876993] proxy/vless/outbound: tunneling request to tcp:149.154.167.51:80 via cp.landing-lv.rfid-technologies.org:443';
        const outboundDial = '2026/06/08 15:07:53 [INFO] [3278736167] transport/internet/splithttp: XHTTP is dialing to tcp:90.156.217.107:443, mode packet-up, HTTP version 2, host bonus05-03.uiu.fyi';
        const accessWithOutboundTag = '2026/06/09 22:26:25 from 192.168.1.83:60025 accepted tcp:149.154.167.99:443 [redirect -> cdn.pecan.run--Анти_Белые_списки_00-03.1f07]';

        console.log(JSON.stringify({
          accessDestinations: collectXrayLogDestinationIpPorts(access),
          sniffedDomains: collectXrayLogDomainCandidates(sniffed),
          routeDomains: collectXrayLogDomainCandidates(route),
          tunProcessingDestinations: collectXrayLogDestinationIpPorts(tunProcessing),
          directDialDestinations: collectXrayLogDestinationIpPorts(directDial),
          outboundEndpointDialDomains: collectXrayLogDomainCandidates(outboundEndpointDial),
          outboundTunnelViaEndpointDestinations: collectXrayLogDestinationIpPorts(outboundTunnelViaEndpoint),
          outboundTunnelViaEndpointDomains: collectXrayLogDomainCandidates(outboundTunnelViaEndpoint),
          outboundDialDestinations: collectXrayLogDestinationIpPorts(outboundDial),
          outboundDialDomains: collectXrayLogDomainCandidates(outboundDial),
          accessWithOutboundTagDestinations: collectXrayLogDestinationIpPorts(accessWithOutboundTag),
          accessWithOutboundTagDomains: collectXrayLogDomainCandidates(accessWithOutboundTag),
          connId: extractXrayLogConnectionId(sniffed),
          normalized: normalizeXrayLogDomain('https://Ab.ChatGPT.com:443/path'),
          badIpDomain: normalizeXrayLogDomain('8.8.8.8'),
        }));
        """
    )

    assert data["accessDestinations"][0]["ip"] == "8.6.112.0"
    assert data["accessDestinations"][0]["port"] == "443"
    assert data["sniffedDomains"][0]["domain"] == "ab.chatgpt.com"
    assert data["routeDomains"][0]["domain"] == "ab.chatgpt.com"
    assert data["tunProcessingDestinations"][0]["ip"] == "110.242.74.102"
    assert data["tunProcessingDestinations"][0]["port"] == "80"
    assert data["tunProcessingDestinations"][0]["kind"] == "processing"
    assert data["directDialDestinations"][0]["ip"] == "110.242.74.102"
    assert data["directDialDestinations"][0]["port"] == "80"
    assert data["directDialDestinations"][0]["kind"] == "dial"
    assert data["outboundEndpointDialDomains"] == []
    assert data["outboundTunnelViaEndpointDestinations"][0]["ip"] == "149.154.167.51"
    assert data["outboundTunnelViaEndpointDestinations"][0]["port"] == "80"
    assert data["outboundTunnelViaEndpointDomains"] == []
    assert data["outboundDialDestinations"] == []
    assert data["outboundDialDomains"] == []
    assert data["accessWithOutboundTagDestinations"][0]["ip"] == "149.154.167.99"
    assert data["accessWithOutboundTagDomains"] == []
    assert data["connId"] == "3868264735"
    assert data["normalized"] == "ab.chatgpt.com"
    assert data["badIpDomain"] == ""
