#!/usr/bin/env python3
"""Evaluate T-11B: real VP8 Bob revocation + independent Carol positive control.

Only browser-local telemetry is read. Its timestamps are compared as UTC;
run all three participants on the same host or clocks reliably synchronized.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timedelta, timezone
import json
import sys
from pathlib import Path


def parse_time(value: str) -> datetime:
    if not isinstance(value,str):
        raise ValueError('Missing or nonstring ISO timestamp')
    dt=datetime.fromisoformat(value.replace('Z','+00:00'))
    if dt.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    return dt.astimezone(timezone.utc)


def load(path: Path, label: str, role: str) -> dict:
    raw=json.loads(path.read_text(encoding='utf-8-sig'))
    if raw.get('schemaVersion')!='t11b-browser-1':
        raise ValueError(f'{path.name}: expected t11b-browser-1, got {raw.get("schemaVersion")!r}')
    if str(raw.get('sessionLabel','')).casefold()!=label.casefold() or raw.get('role')!=role:
        raise ValueError(f'{path.name}: expected {label} role={role}, got {raw.get("sessionLabel")!r} role={raw.get("role")!r}')
    if not raw.get('roomId'):
        raise ValueError(f'{path.name}: roomId not found')
    if not isinstance(raw.get('events'),list) or not isinstance(raw.get('samples'),list):
        raise ValueError(f'{path.name}: events/samples missing')
    for v in raw['events']+raw['samples']:
        v['_time']=parse_time(v['at'])
    raw['samples'].sort(key=lambda s:s['_time'])
    return raw


def window(samples:list[dict],t0:datetime,t1:datetime,field:str,min_span:float=3.0,only_inbound:bool=False):
    a=[s for s in samples if t0<=s['_time']<=t1 and (not only_inbound or s.get('inboundStatsPresent')) and isinstance(s.get(field),(float,int)) and not isinstance(s.get(field),bool)]
    if len(a)<3:
        return None
    span=(a[-1]['_time']-a[0]['_time']).total_seconds()
    if span<min_span:
        return None
    values=[float(s[field]) for s in a]
    if any(v2<v1 for v1,v2 in zip(values,values[1:])):
        return None # counter reset or report replacement; cannot assert zero
    delta=values[-1]-values[0]
    return {'delta':delta,'seconds':span,'rate':delta/span,'samples':len(a),'start':a[0]['_time'].isoformat(),'end':a[-1]['_time'].isoformat()}


def fmt(m, unit):
    return 'INSUFFICIENT DATA' if m is None else f'{m["rate"]:.2f} {unit} ({m["delta"]:.0f} over {m["seconds"]:.1f}s, {m["samples"]} samples)'


def evaluate(alice:dict,bob:dict,carol:dict) -> tuple[str,list[str]]:
    lines=[];failed=[];missing=[]
    if len({alice['roomId'],bob['roomId'],carol['roomId']})!=1:
        return 'FAIL',['Different roomIds in Alice/Bob/Carol evidence. Do not combine different experiments.']
    revokes=[e for e in alice['events'] if e.get('type')=='revoke_http_ok' and str(e.get('targetLabel','')).casefold()=='bob']
    if len(revokes)!=1:
        return 'INCONCLUSIVE',[f'Expected exactly one successful Alice->Bob revoke_http_ok event, found {len(revokes)}.']
    t=revokes[0]['_time']
    lines.append(f'Room: {alice["roomId"]} | Alice successfully revoked Bob: {t.isoformat()}')
    sources=[e for e in alice['events'] if e.get('type')=='t11b_source_selected' and e['_time']<=t]
    if not sources or sources[-1].get('mode')!='screen_capture':
        missing.append('Alice did not record screen_capture source mode before revocation (synthetic video not accepted).')
    closes=[e for e in bob['events'] if e.get('type')=='sfu_socket_closed' and e.get('closeCode')==4003 and (t-timedelta(seconds=3))<=e['_time']<=t+timedelta(seconds=8)]
    if not closes:
        failed.append('Bob has no matching WS close 4003 after revocation request.')
        close=None
    else:
        close=closes[-1]
        if not close.get('ignoredLocally'):
            missing.append('Bob did not keep his local PeerConnection open (ignore-notices box must be checked).')
        lines.append(f'Bob WS close 4003: {close["_time"].isoformat()} | ignoreNotices={close.get("ignoredLocally")}')
    # Pre: 7-to-1 seconds before Alice's successful HTTP revocation.
    pre0=t-timedelta(seconds=8);pre1=t-timedelta(seconds=1)
    # Post: 2-to-12 seconds after. This is intentionally not an instantaneous cutoff metric.
    post0=t+timedelta(seconds=2);post1=t+timedelta(seconds=12)
    a_pre=window(alice['samples'],pre0,pre1,'framesEncoded')
    a_post=window(alice['samples'],post0,post1,'framesEncoded')
    b_pre=window(bob['samples'],pre0,pre1,'framesDecoded',only_inbound=True)
    c_pre=window(carol['samples'],pre0,pre1,'framesDecoded',only_inbound=True)
    c_post=window(carol['samples'],post0,post1,'framesDecoded',only_inbound=True)
    lines.append('Before revoke [-8,-1]s: Alice encoded '+fmt(a_pre,'fps')+'; Bob decoded '+fmt(b_pre,'fps')+'; Carol decoded '+fmt(c_pre,'fps'))
    lines.append('After revoke [+2,+12]s: Alice encoded '+fmt(a_post,'fps')+'; Carol decoded '+fmt(c_post,'fps'))
    for label,m in [('Alice pre',a_pre),('Alice post',a_post),('Bob pre',b_pre),('Carol pre',c_pre),('Carol post',c_post)]:
        if m is None: missing.append(label+' window lacks at least 3 valid samples spanning 3s')
    if a_pre and a_pre['rate']<5: missing.append('Alice source under 5 encoded fps before revoke (moving video required).')
    if a_post and a_post['rate']<5: failed.append('Alice stopped or nearly stopped sending video after revocation; positive control invalid.')
    if b_pre and b_pre['rate']<5: missing.append('Bob had under 5 decoded fps before revocation; not a meaningful live-video negative control.')
    if c_pre and c_pre['rate']<5: missing.append('Carol had under 5 decoded fps before revocation; not a meaningful positive control.')
    if c_post:
        if c_post['rate']<5: failed.append('Carol did not maintain >=5 decoded fps after Bob revocation.')
        if c_pre and c_post['rate']<0.6*c_pre['rate']:
            failed.append('Carol post-revoke decoded fps fell below 60% of her pre-revoke baseline.')
    # Quiet interval starts no sooner than 2s after revoke and 1s after WS close.
    quiet0=max(t+timedelta(seconds=2), close['_time']+timedelta(seconds=1) if close else t)
    quiet1=quiet0+timedelta(seconds=8)
    playback=window(bob['samples'],quiet0,quiet1,'playbackFramesTotal',min_span=5.0)
    decoded=window(bob['samples'],quiet0,quiet1,'framesDecoded',min_span=5.0,only_inbound=True)
    packets=window(bob['samples'],quiet0,quiet1,'packetsReceived',min_span=5.0,only_inbound=True)
    bytes_in=window(bob['samples'],quiet0,quiet1,'bytesReceived',min_span=5.0,only_inbound=True)
    lines.append('Bob quiet interval: '+quiet0.isoformat()+' .. '+quiet1.isoformat())
    lines.append('Bob post-revocation playback frames: '+fmt(playback,'frames/s'))
    lines.append('Bob post-revocation decoded frames: '+fmt(decoded,'frames/s'))
    lines.append('Bob post-revocation RTP packets: '+fmt(packets,'packets/s'))
    lines.append('Bob post-revocation RTP bytes: '+fmt(bytes_in,'bytes/s'))
    if playback is None and decoded is None:
        missing.append('No reliable Bob playback or decoded-frame counter across quiet interval.')
    if playback is not None and playback['delta']>0:
        failed.append(f'Bob displayed {playback["delta"]:.0f} new video frames during quiet interval.')
    if decoded is not None and decoded['delta']>0:
        failed.append(f'Bob decoded {decoded["delta"]:.0f} new video frames during quiet interval.')
    if packets is None or bytes_in is None:
        missing.append('Bob inbound RTP stats absent or not continuous after revocation: cannot verify packet-level cutoff from browser; compare T-10B.')
    if packets is not None and packets['delta']>0:
        failed.append(f'Bob received {packets["delta"]:.0f} RTP packets after grace window.')
    if bytes_in is not None and bytes_in['delta']>0:
        failed.append(f'Bob received {bytes_in["delta"]:.0f} RTP payload bytes after grace window.')
    if failed:
        lines+=['FAIL: '+x for x in failed]
        lines+=['LIMITATION: '+x for x in missing]
        return 'FAIL',lines
    if missing:
        lines+=['INCONCLUSIVE: '+x for x in missing]
        return 'INCONCLUSIVE',lines
    lines.append('PASS: Bob terminated with 4003 and no RTP or video progress in the quiet interval; Carol continued decoding, with Alice still sending.')
    return 'PASS',lines


def main() -> int:
    ap=argparse.ArgumentParser(description='Analyze same-run Alice, Bob, Carol T-11B exports (UTC timestamps)')
    ap.add_argument('alice',type=Path)
    ap.add_argument('bob',type=Path)
    ap.add_argument('carol',type=Path)
    ap.add_argument('--out',type=Path,help='Optional human-readable results .txt path')
    a=ap.parse_args()
    try:
        alice=load(a.alice,'Alice','publisher');bob=load(a.bob,'Bob','viewer');carol=load(a.carol,'Carol','viewer')
        status,lines=evaluate(alice,bob,carol)
    except (ValueError,KeyError,OSError,json.JSONDecodeError) as exc:
        print('INPUT ERROR: '+str(exc),file=sys.stderr)
        return 3
    output='SafeStream T-11B | '+status+'\n'+'\n'.join(lines)+'\n'
    print(output,end='')
    if a.out:
        a.out.parent.mkdir(parents=True,exist_ok=True)
        a.out.write_text(output,encoding='utf-8')
        print('Report: '+str(a.out))
    return {'PASS':0,'FAIL':1,'INCONCLUSIVE':2}[status]

if __name__=='__main__':
    raise SystemExit(main())
