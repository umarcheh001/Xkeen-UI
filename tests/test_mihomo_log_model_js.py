import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(body):
    script = "import assert from 'node:assert/strict'; import {createMihomoLogModel} from './xkeen-ui/static/js/features/mihomo_clash/log_model.js'; const m=createMihomoLogModel(); const dto=(i)=>({sequence:1,message:`[TCP] 192.168.1.2:${1000+i} --> example.org:443 match Match using DIRECT`});\n" + body + ";console.log('true')"
    result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, encoding="utf-8", check=True)
    return json.loads(result.stdout)


def test_limit_500_and_repeated_sequences():
    assert run("for(let i=0;i<501;i++)m.append(dto(i));const s=m.snapshot();assert.equal(s.records.length,500);assert.equal(new Set(s.records.map(r=>r.id)).size,500);assert.equal(s.records[0].sourcePort,'1001');")


def test_snapshot_is_stable_when_next_event_arrives():
    assert run("m.append(dto(0));const old=m.snapshot();m.append(dto(1));assert.equal(old.records.length,1);assert.equal(old.records.at(-1).id,1);assert.equal(m.snapshot().records.length,2)")


def test_pause_snapshot_and_eviction():
    assert run("m.append(dto(0));m.setPaused(true);m.select(1,{});for(let i=1;i<502;i++)m.append(dto(i));let s=m.snapshot();assert.equal(s.visible.length,1);assert.equal(s.visible[0].id,1);assert.equal(s.pending,501);assert.equal(s.evictedWhilePaused,2);assert.deepEqual(s.selected,[1]);m.setPaused(false);s=m.snapshot();assert.equal(s.records.length,500);assert.equal(s.visible.length,500);assert.equal(s.selected.length,0);assert.equal(s.pending,0)")


def test_filters_summary_and_dns():
    assert run("m.append(dto(0));m.append({message:'[DNS] cache hit example.org --> [1.1.1.1]'});m.append({level:'error',message:'unknown'});let s=m.snapshot();assert.equal(s.visible.length,2);assert.equal(s.counts.dns,1);assert.equal(s.summary.total,1);m.setFilters({kinds:['dns']});s=m.snapshot();assert.equal(s.visible.length,2);assert.equal(s.summary.total,0);m.setFilters({level:'error'});assert.equal(m.snapshot().visible.length,1)")


def test_selection_range_and_copy_uses_raw():
    assert run("for(let i=0;i<4;i++)m.append(dto(i));m.select(4,{});m.select(2,{range:true});let s=m.snapshot();assert.deepEqual(new Set(s.selected),new Set([4,3,2]));assert.equal(s.visible.find(r=>r.id===4).raw,dto(3).message);m.clearSelection();assert.equal(m.snapshot().selected.length,0);m.setFilters({query:'nothing'});assert.equal(m.snapshot().visible.length,0)")
