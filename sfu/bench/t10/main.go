// Command t10 is a loopback-only SafeStream T-10A research load driver.
// It negotiates real Pion WebRTC transports and sends synthetic VP8-labelled
// RTP packets, NOT decodable video. It does not record media or export tokens.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const origin = "http://localhost:5173"

type envelope struct {
	Type   string `json:"type"`
	RoomID string `json:"roomId,omitempty"`
	Token  string `json:"token,omitempty"`
	SDP    string `json:"sdp,omitempty"`
	Role   string `json:"role,omitempty"`
	Error  string `json:"error,omitempty"`
}

type account struct {
	Secret string `json:"secret"`
	User   struct {
		ID string `json:"id"`
	} `json:"user"`
}

type clientAPI struct {
	base string
	http *http.Client
}

func (a clientAPI) call(ctx context.Context, method, path, bearer string, input any, output any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.base+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("API request failed: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("API %s %s returned HTTP %d", method, path, res.StatusCode)
	}
	if output != nil {
		if err := json.NewDecoder(io.LimitReader(res.Body, 8192)).Decode(output); err != nil {
			return fmt.Errorf("API JSON: %w", err)
		}
	}
	return nil
}

func (a clientAPI) session(ctx context.Context, label string) (account, error) {
	var result account
	err := a.call(ctx, http.MethodPost, "/api/sessions", "", map[string]string{"label": label}, &result)
	if err == nil && len(result.Secret) != 32 {
		err = errors.New("invalid demo session response")
	}
	return result, err
}

func (a clientAPI) room(ctx context.Context, publisher account) (string, error) {
	var result struct {
		RoomID string `json:"roomId"`
	}
	err := a.call(ctx, http.MethodPost, "/api/rooms", publisher.Secret, nil, &result)
	if err == nil && len(result.RoomID) != 12 {
		err = errors.New("invalid room response")
	}
	return result.RoomID, err
}

func (a clientAPI) join(ctx context.Context, room string, owner, viewer account) error {
	var result struct {
		Invite string `json:"invite"`
	}
	if err := a.call(ctx, http.MethodPost, "/api/rooms/"+room+"/invites", owner.Secret, nil, &result); err != nil {
		return err
	}
	if len(result.Invite) != 16 {
		return errors.New("invalid invite response")
	}
	return a.call(ctx, http.MethodPost, "/api/rooms/"+room+"/join", viewer.Secret, map[string]string{"invite": result.Invite}, nil)
}

type endpoint struct {
	socket      *websocket.Conn
	peer        *webrtc.PeerConnection
	track       *webrtc.TrackLocalStaticRTP
	packets     atomic.Int64
	bytes       atomic.Int64
	failed      atomic.Bool
	closeCode   atomic.Int64
	connectedMs float64
	stateCh     chan webrtc.PeerConnectionState
}

func (e *endpoint) close() {
	if e == nil {
		return
	}
	if e.peer != nil {
		_ = e.peer.Close()
	}
	if e.socket != nil {
		_ = e.socket.Close()
	}
}

func (e *endpoint) waitConnected(ctx context.Context) error {
	timeout := time.NewTimer(12 * time.Second)
	defer timeout.Stop()
	for {
		state := e.peer.ConnectionState()
		if state == webrtc.PeerConnectionStateConnected {
			return nil
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			return fmt.Errorf("peer state %s", state.String())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timeout.C:
			return errors.New("WebRTC connection timeout")
		case <-e.stateCh:
		}
	}
}

func attach(ctx context.Context, wsURL, room string, user account, publisher bool) (*endpoint, error) {
	started := time.Now()
	e := &endpoint{stateCh: make(chan webrtc.PeerConnectionState, 8)}
	fail := func(err error) (*endpoint, error) { e.close(); return nil, err }
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: nil})
	if err != nil {
		return nil, err
	}
	e.peer = pc
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed {
			e.failed.Store(true)
		}
		select {
		case e.stateCh <- state:
		default:
		}
	})
	if publisher {
		track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "t10-synthetic")
		if err != nil {
			return fail(err)
		}
		e.track = track
		sender, err := pc.AddTrack(track)
		if err != nil {
			return fail(err)
		}
		go func() {
			buf := make([]byte, 1500)
			for {
				if _, _, err := sender.Read(buf); err != nil {
					return
				}
			}
		}()
	} else {
		_, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
		if err != nil {
			return fail(err)
		}
		pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			for {
				packet, _, err := remote.ReadRTP()
				if err != nil {
					return
				}
				e.packets.Add(1)
				e.bytes.Add(int64(len(packet.Payload)))
			}
		})
	}
	header := http.Header{"Origin": []string{origin}}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	socket, _, err := dialer.DialContext(ctx, wsURL, header)
	if err != nil {
		return fail(fmt.Errorf("WebSocket dial: %w", err))
	}
	e.socket = socket
	_ = socket.SetReadDeadline(time.Now().Add(20 * time.Second))
	if err := socket.WriteJSON(envelope{Type: "auth", RoomID: room, Token: user.Secret}); err != nil {
		return fail(fmt.Errorf("send authentication: %w", err))
	}
	var reply envelope
	if err := socket.ReadJSON(&reply); err != nil {
		return fail(fmt.Errorf("authorization: %w", err))
	}
	expectedRole := "viewer"
	if publisher {
		expectedRole = "publisher"
	}
	if reply.Type != "ready" || reply.Role != expectedRole {
		return fail(fmt.Errorf("unexpected authorization response type=%q role=%q", reply.Type, reply.Role))
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fail(err)
	}
	gather := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return fail(err)
	}
	select {
	case <-ctx.Done():
		return fail(ctx.Err())
	case <-time.After(12 * time.Second):
		return fail(errors.New("ICE gathering timed out"))
	case <-gather:
	}
	if err := socket.WriteJSON(envelope{Type: "offer", SDP: pc.LocalDescription().SDP}); err != nil {
		return fail(fmt.Errorf("send offer: %w", err))
	}
	if err := socket.ReadJSON(&reply); err != nil {
		return fail(fmt.Errorf("receive answer: %w", err))
	}
	if reply.Type != "answer" {
		return fail(fmt.Errorf("unexpected SDP answer type=%q", reply.Type))
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: reply.SDP}); err != nil {
		return fail(fmt.Errorf("set answer: %w", err))
	}
	if err := e.waitConnected(ctx); err != nil {
		return fail(err)
	}
	e.connectedMs = float64(time.Since(started).Microseconds()) / 1000.0
	_ = socket.SetReadDeadline(time.Time{})
	go func() {
		for {
			var msg envelope
			err := socket.ReadJSON(&msg)
			if err != nil {
				var closeErr *websocket.CloseError
				if errors.As(err, &closeErr) {
					e.closeCode.Store(int64(closeErr.Code))
				}
				return
			}
		}
	}()
	return e, nil
}

type viewerResult struct {
	Index                int     `json:"index"`
	Connected            bool    `json:"connected"`
	ConnectionMs         float64 `json:"connectionMs,omitempty"`
	ReceivedPackets      int64   `json:"receivedPackets"`
	ReceivedPayloadBytes int64   `json:"receivedPayloadBytes"`
	FailedOrClosed       bool    `json:"failedOrClosed"`
	CloseCode            int64   `json:"closeCode,omitempty"`
	Error                string  `json:"error,omitempty"`
}

type levelResult struct {
	RequestedViewers          int            `json:"requestedViewers"`
	AdmittedAndConnected      int            `json:"admittedAndConnected"`
	ViewersWithPackets        int            `json:"viewersWithPackets"`
	PacketReceptionRatePct    float64        `json:"packetReceptionRatePct"`
	PublisherPacketsSent      int64          `json:"publisherPacketsSent"`
	PublisherWriteErrors      int64          `json:"publisherWriteErrors"`
	TotalPacketsReceived      int64          `json:"totalPacketsReceived"`
	TotalPayloadBytesReceived int64          `json:"totalPayloadBytesReceived"`
	P50ConnectionMs           float64        `json:"p50ConnectionMs"`
	P95ConnectionMs           float64        `json:"p95ConnectionMs"`
	P99ConnectionMs           float64        `json:"p99ConnectionMs"`
	DurationSeconds           float64        `json:"durationSeconds"`
	SetupSeconds              float64        `json:"setupSeconds"`
	Viewers                   []viewerResult `json:"viewers"`
}

type report struct {
	SchemaVersion    string        `json:"schemaVersion"`
	GeneratedAt      string        `json:"generatedAt"`
	Scope            string        `json:"scope"`
	Host             string        `json:"host"`
	GoVersion        string        `json:"goVersion"`
	SyntheticRTP     bool          `json:"syntheticRtp"`
	DecodableVideo   bool          `json:"decodableVideo"`
	PacketsPerSecond int           `json:"packetsPerSecond"`
	PayloadBytes     int           `json:"payloadBytes"`
	Levels           []levelResult `json:"levels"`
	Limitations      []string      `json:"limitations"`
}

func percentile(values []float64, q float64) float64 {
	if len(values) == 0 {
		return 0
	}
	copyOf := append([]float64(nil), values...)
	sort.Float64s(copyOf)
	if q <= 0 {
		return copyOf[0]
	}
	if q >= 1 {
		return copyOf[len(copyOf)-1]
	}
	ix := q * float64(len(copyOf)-1)
	lo := int(math.Floor(ix))
	hi := int(math.Ceil(ix))
	return copyOf[lo] + (copyOf[hi]-copyOf[lo])*(ix-float64(lo))
}

func parseLevels(s string) ([]int, error) {
	var result []int
	seen := make(map[int]bool)
	for _, part := range strings.Split(s, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n < 1 || n > 20 || seen[n] {
			return nil, fmt.Errorf("invalid/duplicate level %q; use unique levels 1..20", part)
		}
		seen[n] = true
		result = append(result, n)
	}
	if len(result) < 1 || len(result) > 5 {
		return nil, errors.New("choose 1..5 load levels")
	}
	return result, nil
}

func loopbackURL(value, scheme string) error {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != scheme || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("requires loopback-only %s URL", scheme)
	}
	ip := net.ParseIP(u.Hostname())
	if u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return errors.New("refusing non-loopback endpoint: T-10 is local-lab only")
	}
	return nil
}

// writePhase emits a best-effort phase marker for local process samplers.
// Phase "active" starts after WebRTC negotiation and RTP warmup; "complete"
// is emitted when the fixed-duration sampling window ends. The marker does
// not change media forwarding or the benchmark's original JSON semantics.
func writePhase(path, phase string) {
	if path == "" {
		return
	}
	if err := os.WriteFile(path, []byte(phase+"\n"), 0600); err != nil {
		fmt.Fprintln(os.Stderr, "T-10C phase marker error:", err)
	}
}

func runLevel(ctx context.Context, api clientAPI, sfURL string, viewers, pps, payloadSize int, dur time.Duration, phaseFile string) levelResult {
	begin := time.Now()
	result := levelResult{RequestedViewers: viewers, Viewers: make([]viewerResult, viewers)}
	for i := range result.Viewers {
		result.Viewers[i].Index = i + 1
	}
	publisher, err := api.session(ctx, "T10_Publisher")
	if err != nil {
		result.Viewers[0].Error = "publisher API session: " + err.Error()
		return result
	}
	room, err := api.room(ctx, publisher)
	if err != nil {
		result.Viewers[0].Error = "create room: " + err.Error()
		return result
	}
	pub, err := attach(ctx, sfURL, room, publisher, true)
	if err != nil {
		result.Viewers[0].Error = "publisher WebRTC: " + err.Error()
		return result
	}
	defer pub.close()
	peers := make([]*endpoint, viewers)
	defer func() {
		for _, p := range peers {
			if p != nil {
				p.close()
			}
		}
	}()
	for i := 0; i < viewers; i++ {
		viewer, err := api.session(ctx, fmt.Sprintf("T10_Viewer_%02d", i+1))
		if err == nil {
			err = api.join(ctx, room, publisher, viewer)
		}
		if err != nil {
			result.Viewers[i].Error = "viewer authorization: " + err.Error()
			continue
		}
		peer, err := attach(ctx, sfURL, room, viewer, false)
		if err != nil {
			result.Viewers[i].Error = "viewer WebRTC: " + err.Error()
			continue
		}
		peers[i] = peer
		result.Viewers[i].Connected = true
		result.Viewers[i].ConnectionMs = peer.connectedMs
		result.AdmittedAndConnected++
	}
	result.SetupSeconds = time.Since(begin).Seconds()
	if result.AdmittedAndConnected == 0 {
		return result
	}

	// The payload is VP8-labelled but deliberately NOT a valid encoded frame.
	// Thus packet delivery is measurable; browser framesDecoded is NOT.
	payload := make([]byte, payloadSize)
	payload[0] = 0x10 // VP8 RTP payload descriptor: start of partition 0
	for i := 1; i < len(payload); i++ {
		payload[i] = byte((i * 17) % 251)
	}
	interval := time.Second / time.Duration(pps)
	sendingCtx, stopSending := context.WithCancel(ctx)
	var sent, writeErrors atomic.Int64
	doneSending := make(chan struct{})
	go func() {
		defer close(doneSending)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		var seq uint16
		var ts uint32
		for {
			select {
			case <-sendingCtx.Done():
				return
			case <-ticker.C:
				seq++
				ts += uint32(90000 / pps)
				pkt := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: ts, Marker: true, PayloadType: 96}, Payload: payload}
				if err := pub.track.WriteRTP(pkt); err != nil {
					writeErrors.Add(1)
				} else {
					sent.Add(1)
				}
			}
		}
	}()
	// Warm up ICE/DTLS/RTP forwarding before collecting a fixed-duration sample.
	time.Sleep(700 * time.Millisecond)
	initialPackets := make([]int64, viewers)
	initialBytes := make([]int64, viewers)
	for i, p := range peers {
		if p != nil {
			initialPackets[i] = p.packets.Load()
			initialBytes[i] = p.bytes.Load()
		}
	}
	initialSent := sent.Load()
	initialErrors := writeErrors.Load()
	started := time.Now()
	writePhase(phaseFile, "active")
	timer := time.NewTimer(dur)
	select {
	case <-ctx.Done():
		timer.Stop()
	case <-timer.C:
	}
	result.DurationSeconds = time.Since(started).Seconds()
	writePhase(phaseFile, "complete")
	stopSending()
	<-doneSending
	time.Sleep(250 * time.Millisecond) // allow already-in-flight packets to arrive; not a cutoff measurement
	result.PublisherPacketsSent = sent.Load() - initialSent
	result.PublisherWriteErrors = writeErrors.Load() - initialErrors
	var latencies []float64
	for i, p := range peers {
		if p == nil {
			continue
		}
		row := &result.Viewers[i]
		row.ReceivedPackets = p.packets.Load() - initialPackets[i]
		row.ReceivedPayloadBytes = p.bytes.Load() - initialBytes[i]
		row.FailedOrClosed = p.failed.Load() || p.peer.ConnectionState() != webrtc.PeerConnectionStateConnected
		row.CloseCode = p.closeCode.Load()
		if row.ReceivedPackets > 0 {
			result.ViewersWithPackets++
		}
		result.TotalPacketsReceived += row.ReceivedPackets
		result.TotalPayloadBytesReceived += row.ReceivedPayloadBytes
		latencies = append(latencies, row.ConnectionMs)
	}
	result.P50ConnectionMs = percentile(latencies, .50)
	result.P95ConnectionMs = percentile(latencies, .95)
	result.P99ConnectionMs = percentile(latencies, .99)
	if result.PublisherPacketsSent > 0 && result.AdmittedAndConnected > 0 {
		// Aggregate receiver packets / (sent * connected). It is an estimate,
		// NOT end-to-end packet loss, given buffering, warmup and scheduling.
		result.PacketReceptionRatePct = 100 * float64(result.TotalPacketsReceived) / float64(result.PublisherPacketsSent*int64(result.AdmittedAndConnected))
	}
	return result
}

func main() {
	apiURL := flag.String("api", "http://127.0.0.1:3101", "isolated local Node API")
	sfURL := flag.String("sfu", "ws://127.0.0.1:3002/ws", "local Pion relay")
	levels := flag.String("levels", "1,2,5,10,20", "viewer counts, <=20")
	seconds := flag.Int("seconds", 6, "measurement duration per load level, 3..30")
	pps := flag.Int("pps", 30, "synthetic RTP packets per second, 5..60")
	payload := flag.Int("payload", 900, "synthetic RTP payload bytes, 100..1100")
	out := flag.String("out", "../reports/t10/t10a.json", "JSON report path")
	phaseFile := flag.String("phase-file", "", "optional phase marker used by local resource sampling")
	flag.Parse()
	counts, err := parseLevels(*levels)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if *seconds < 3 || *seconds > 30 || *pps < 5 || *pps > 60 || *payload < 100 || *payload > 1100 {
		fmt.Fprintln(os.Stderr, "invalid benchmark bounds")
		os.Exit(2)
	}
	if err := loopbackURL(*apiURL, "http"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := loopbackURL(*sfURL, "ws"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if !strings.HasSuffix(*sfURL, "/ws") {
		fmt.Fprintln(os.Stderr, "SFU URL must target /ws")
		os.Exit(2)
	}
	api := clientAPI{base: strings.TrimSuffix(*apiURL, "/"), http: &http.Client{Timeout: 5 * time.Second}}
	ctx := context.Background()
	var health struct {
		OK bool `json:"ok"`
	}
	if err := api.call(ctx, http.MethodGet, "/api/health", "", nil, &health); err != nil || !health.OK {
		fmt.Fprintln(os.Stderr, "Node health check failed (start the isolated local API):", err)
		os.Exit(1)
	}
	result := report{SchemaVersion: "t10a-1", GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano), Scope: "single-host Pion WebRTC RTP transport load, not decoded video", Host: runtime.GOOS + "/" + runtime.GOARCH, GoVersion: runtime.Version(), SyntheticRTP: true, DecodableVideo: false, PacketsPerSecond: *pps, PayloadBytes: *payload, Limitations: []string{
		"Synthetic VP8-labelled RTP payload is not decodable video; no framesDecoded or user-perceived latency is measured.",
		"One host, serial connection establishment, single run per load; percentiles descriptive, not confidence intervals.",
		"Packet-reception percentage is an approximate lab ratio, not formal network packet loss or transport SLA.",
		"No process CPU/memory profiling, bandwidth adaptation, audio, TURN, or adverse network simulation.",
		"This test does not measure revocation latency; that is T-10B.",
	}}
	fmt.Println("SafeStream T-10A | loopback-only synthetic RTP over real WebRTC (NO video decoding)")
	for _, count := range counts {
		fmt.Printf("testing %d viewers...\n", count)
		r := runLevel(ctx, api, *sfURL, count, *pps, *payload, time.Duration(*seconds)*time.Second, *phaseFile)
		result.Levels = append(result.Levels, r)
		fmt.Printf("  connected=%d/%d media=%d/%d packets=%d sent=%d p95-connect=%.1fms\n", r.AdmittedAndConnected, count, r.ViewersWithPackets, r.AdmittedAndConnected, r.TotalPacketsReceived, r.PublisherPacketsSent, r.P95ConnectionMs)
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0700); err != nil {
		fmt.Fprintln(os.Stderr, "report directory:", err)
		os.Exit(1)
	}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, append(encoded, '\n'), 0600); err != nil {
		fmt.Fprintln(os.Stderr, "write report:", err)
		os.Exit(1)
	}
	fmt.Println("Report:", *out)
	for _, r := range result.Levels {
		if r.AdmittedAndConnected != r.RequestedViewers || r.ViewersWithPackets != r.AdmittedAndConnected {
			fmt.Println("INCOMPLETE: at least one requested viewer failed connection or RTP reception; inspect JSON")
			os.Exit(1)
		}
	}
	fmt.Println("OBSERVED: all requested viewers negotiated WebRTC and received synthetic RTP in these runs")
}
