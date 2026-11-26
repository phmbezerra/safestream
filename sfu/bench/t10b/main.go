// Command t10b is a loopback-only SafeStream T-10B revocation-under-load driver.
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
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
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

// Revoke a synthetic viewer through the actual Node authorization endpoint.
// The returned duration covers the HTTP request/response, NOT the SFU close.
func (a clientAPI) revoke(ctx context.Context, room string, publisher, viewer account) (float64, error) {
	start := time.Now()
	err := a.call(ctx, http.MethodDelete, "/api/rooms/"+room+"/members/"+viewer.User.ID, publisher.Secret, nil, nil)
	return ms(time.Since(start)), err
}

func (a clientAPI) deniedMembership(ctx context.Context, room string, viewer account) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base+"/api/rooms/"+room, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+viewer.Secret)
	res, err := a.http.Do(req)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	return res.StatusCode == http.StatusForbidden, nil
}

func readmissionDenied(ctx context.Context, wsURL, room string, viewer account) (bool, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	socket, _, err := dialer.DialContext(ctx, wsURL, http.Header{"Origin": []string{origin}})
	if err != nil {
		return false, err
	}
	defer socket.Close()
	if err := socket.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		return false, err
	}
	if err := socket.WriteJSON(envelope{Type: "auth", RoomID: room, Token: viewer.Secret}); err != nil {
		return false, err
	}
	var reply envelope
	err = socket.ReadJSON(&reply)
	var closeErr *websocket.CloseError
	if errors.As(err, &closeErr) {
		return closeErr.Code == 4001, nil
	}
	if err == nil {
		return false, fmt.Errorf("unexpected authorization response: %q", reply.Type)
	}
	return false, err
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

type endpoint struct {
	socket      *websocket.Conn
	peer        *webrtc.PeerConnection
	track       *webrtc.TrackLocalStaticRTP
	packets     atomic.Int64
	bytes       atomic.Int64
	failed      atomic.Bool
	closeCode   atomic.Int64
	wsCloseAtNS atomic.Int64
	lastRTPAtNS atomic.Int64
	wsReadDone  chan struct{}
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
	e := &endpoint{stateCh: make(chan webrtc.PeerConnectionState, 8), wsReadDone: make(chan struct{})}
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
		track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "t10b-synthetic")
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
				e.lastRTPAtNS.Store(time.Now().UnixNano())
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
		defer close(e.wsReadDone)
		for {
			var msg envelope
			err := socket.ReadJSON(&msg)
			if err != nil {
				e.wsCloseAtNS.Store(time.Now().UnixNano())
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

type trialResult struct {
	Round                                         int      `json:"round"`
	RequestedViewers                              int      `json:"requestedViewers"`
	ConnectedViewers                              int      `json:"connectedViewers"`
	WarmedViewers                                 int      `json:"warmedViewers"`
	APIRevocationMs                               float64  `json:"apiRevocationResponseMs"`
	MediaWebSocketCloseCode                       int64    `json:"mediaWebSocketCloseCode"`
	MediaWebSocketCloseMs                         float64  `json:"mediaWebSocketCloseMs"`
	LastObservedRTPMsFromRequest                  *float64 `json:"lastObservedRtpMsFromRequest,omitempty"`
	TargetPacketsBetweenHTTPResponseAndQuietStart int64    `json:"targetPacketsBetweenHttpResponseAndQuietStart"`
	TargetPacketsDuringQuietWindow                int64    `json:"targetPacketsDuringQuietWindow"`
	OtherViewersReceivingDuringQuietWindow        int      `json:"otherViewersReceivingDuringQuietWindow"`
	OtherViewersConnectedAtEnd                    int      `json:"otherViewersConnectedAtEnd"`
	ReadmissionDenied4001                         bool     `json:"readmissionDenied4001"`
	MembershipDenied403                           bool     `json:"membershipDenied403"`
	PublisherPacketsSent                          int64    `json:"publisherPacketsSent"`
	PublisherWriteErrors                          int64    `json:"publisherWriteErrors"`
	QuietWindowSeconds                            float64  `json:"quietWindowSeconds"`
	Passed                                        bool     `json:"passed"`
	Issues                                        []string `json:"issues,omitempty"`
}

type report struct {
	SchemaVersion      string        `json:"schemaVersion"`
	GeneratedAt        string        `json:"generatedAt"`
	Scope              string        `json:"scope"`
	Host               string        `json:"host"`
	GoVersion          string        `json:"goVersion"`
	SyntheticRTP       bool          `json:"syntheticRtp"`
	DecodableVideo     bool          `json:"decodableVideo"`
	RequestedViewers   int           `json:"requestedViewers"`
	PacketsPerSecond   int           `json:"packetsPerSecond"`
	QuietWindowSeconds int           `json:"quietWindowSeconds"`
	Rounds             []trialResult `json:"rounds"`
	Limitations        []string      `json:"limitations"`
}

func loopbackURL(value, scheme string) error {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != scheme || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("requires loopback-only %s URL", scheme)
	}
	ip := net.ParseIP(u.Hostname())
	if u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return errors.New("refusing non-loopback endpoint: T-10B is local-lab only")
	}
	return nil
}

func runTrial(ctx context.Context, api clientAPI, sfURL string, round, viewers, pps, payloadSize, quietSeconds int) (r trialResult) {
	r.Round = round
	r.RequestedViewers = viewers
	r.QuietWindowSeconds = float64(quietSeconds)
	addIssue := func(msg string) { r.Issues = append(r.Issues, msg) }

	publisher, err := api.session(ctx, fmt.Sprintf("T10B_Publisher_%d", round))
	if err != nil {
		addIssue("publisher session: " + err.Error())
		return
	}
	room, err := api.room(ctx, publisher)
	if err != nil {
		addIssue("room creation: " + err.Error())
		return
	}
	pub, err := attach(ctx, sfURL, room, publisher, true)
	if err != nil {
		addIssue("publisher WebRTC: " + err.Error())
		return
	}
	defer pub.close()
	peers := make([]*endpoint, viewers)
	users := make([]account, viewers)
	defer func() {
		for _, p := range peers {
			if p != nil {
				p.close()
			}
		}
	}()
	for i := 0; i < viewers; i++ {
		viewer, err := api.session(ctx, fmt.Sprintf("T10B_Viewer_%d_%02d", round, i+1))
		if err == nil {
			err = api.join(ctx, room, publisher, viewer)
		}
		if err != nil {
			addIssue(fmt.Sprintf("viewer %d authorization: %v", i+1, err))
			return
		}
		peer, err := attach(ctx, sfURL, room, viewer, false)
		if err != nil {
			addIssue(fmt.Sprintf("viewer %d WebRTC: %v", i+1, err))
			return
		}
		users[i], peers[i] = viewer, peer
		r.ConnectedViewers++
	}

	payload := make([]byte, payloadSize)
	payload[0] = 0x10 // VP8 payload descriptor; intentionally NOT valid encoded VP8 video
	for i := 1; i < len(payload); i++ {
		payload[i] = byte((i * 17) % 251)
	}
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	var sent, writeErrors atomic.Int64
	defer func() {
		stop()
		<-done
		r.PublisherPacketsSent = sent.Load()
		r.PublisherWriteErrors = writeErrors.Load()
	}()
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second / time.Duration(pps))
		defer ticker.Stop()
		var seq uint16
		var ts uint32
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				seq++
				ts += uint32(90000 / pps)
				packet := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: ts, Marker: true, PayloadType: 96}, Payload: payload}
				if err := pub.track.WriteRTP(packet); err != nil {
					writeErrors.Add(1)
				} else {
					sent.Add(1)
				}
			}
		}
	}()
	// Verify every viewer has received RTP BEFORE revocation.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		count := 0
		for _, p := range peers {
			if p.packets.Load() > 0 {
				count++
			}
		}
		r.WarmedViewers = count
		if count == viewers {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if r.WarmedViewers != viewers {
		addIssue(fmt.Sprintf("RTP warmup incomplete: %d/%d", r.WarmedViewers, viewers))
		return
	}
	// Additional warm-up to reduce startup-related timing noise.
	time.Sleep(300 * time.Millisecond)
	target := peers[0]
	started := time.Now()
	httpDuration, err := api.revoke(ctx, room, publisher, users[0])
	r.APIRevocationMs = httpDuration
	if err != nil {
		addIssue("Node HTTP revoke: " + err.Error())
		return
	}
	atHTTPResponse := target.packets.Load()
	select {
	case <-target.wsReadDone:
	case <-ctx.Done():
		addIssue("cancelled while awaiting media WebSocket close")
		return
	case <-time.After(5 * time.Second):
		addIssue("timeout awaiting media WebSocket close")
		return
	}
	r.MediaWebSocketCloseCode = target.closeCode.Load()
	r.MediaWebSocketCloseMs = float64(target.wsCloseAtNS.Load()-started.UnixNano()) / 1e6
	if r.MediaWebSocketCloseCode != 4003 {
		addIssue(fmt.Sprintf("expected media WebSocket close 4003, got %d", r.MediaWebSocketCloseCode))
	}

	// Settle after close before the *independent quiet-window* observation.
	// Packet delivery in this settling period is reported, not incorrectly claimed impossible.
	time.Sleep(350 * time.Millisecond)
	quietBaseline := target.packets.Load()
	r.TargetPacketsBetweenHTTPResponseAndQuietStart = quietBaseline - atHTTPResponse
	baseline := make([]int64, len(peers))
	for i, p := range peers {
		baseline[i] = p.packets.Load()
	}
	timer := time.NewTimer(time.Duration(quietSeconds) * time.Second)
	select {
	case <-ctx.Done():
		timer.Stop()
		addIssue("cancelled during quiet window")
		return
	case <-timer.C:
	}
	r.TargetPacketsDuringQuietWindow = target.packets.Load() - quietBaseline
	if r.TargetPacketsDuringQuietWindow != 0 {
		addIssue(fmt.Sprintf("revoked viewer received %d packets in quiet window", r.TargetPacketsDuringQuietWindow))
	}
	for i := 1; i < len(peers); i++ {
		p := peers[i]
		if p.packets.Load() > baseline[i] {
			r.OtherViewersReceivingDuringQuietWindow++
		}
		if !p.failed.Load() && p.peer.ConnectionState() == webrtc.PeerConnectionStateConnected {
			r.OtherViewersConnectedAtEnd++
		}
	}
	if r.OtherViewersReceivingDuringQuietWindow != viewers-1 {
		addIssue(fmt.Sprintf("healthy control RTP %d/%d", r.OtherViewersReceivingDuringQuietWindow, viewers-1))
	}
	if r.OtherViewersConnectedAtEnd != viewers-1 {
		addIssue(fmt.Sprintf("healthy control PeerConnections %d/%d", r.OtherViewersConnectedAtEnd, viewers-1))
	}
	r.PublisherWriteErrors = writeErrors.Load()
	if r.PublisherWriteErrors != 0 {
		addIssue("publisher RTP write errors observed")
	}

	last := target.lastRTPAtNS.Load()
	if last > 0 {
		value := float64(last-started.UnixNano()) / 1e6
		r.LastObservedRTPMsFromRequest = &value
	}
	r.ReadmissionDenied4001, err = readmissionDenied(ctx, sfURL, room, users[0])
	if err != nil {
		addIssue("readmission check: " + err.Error())
	} else if !r.ReadmissionDenied4001 {
		addIssue("revoked viewer was not denied with 4001")
	}
	r.MembershipDenied403, err = api.deniedMembership(ctx, room, users[0])
	if err != nil {
		addIssue("membership check: " + err.Error())
	} else if !r.MembershipDenied403 {
		addIssue("revoked viewer membership was not denied with HTTP 403")
	}
	r.Passed = len(r.Issues) == 0
	return
}

func main() {
	apiURL := flag.String("api", "http://127.0.0.1:3101", "isolated local Node API")
	sfURL := flag.String("sfu", "ws://127.0.0.1:3002/ws", "local Pion relay")
	viewers := flag.Int("viewers", 20, "viewers in one room, including revoked viewer (2..20)")
	rounds := flag.Int("rounds", 1, "independent rounds, 1..5")
	pps := flag.Int("pps", 30, "synthetic RTP packets per second, 5..60")
	payload := flag.Int("payload", 900, "synthetic RTP payload bytes, 100..1100")
	quiet := flag.Int("quiet-seconds", 2, "post-close observation window, 1..5 seconds")
	out := flag.String("out", "../reports/t10/t10b.json", "JSON report path")
	flag.Parse()
	if *viewers < 2 || *viewers > 20 || *rounds < 1 || *rounds > 5 || *pps < 5 || *pps > 60 || *payload < 100 || *payload > 1100 || *quiet < 1 || *quiet > 5 {
		fmt.Fprintln(os.Stderr, "invalid T-10B benchmark bounds")
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
		fmt.Fprintln(os.Stderr, "Node health check failed:", err)
		os.Exit(1)
	}
	result := report{
		SchemaVersion: "t10b-1", GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Scope: "single-host policy-enforced media revocation with 1 revoked and N-1 healthy WebRTC viewers",
		Host:  runtime.GOOS + "/" + runtime.GOARCH, GoVersion: runtime.Version(),
		SyntheticRTP: true, DecodableVideo: false, RequestedViewers: *viewers, PacketsPerSecond: *pps, QuietWindowSeconds: *quiet,
		Limitations: []string{
			"Synthetic RTP payloads are not decodable video; no browser framesDecoded or audiovisual quality is measured.",
			"Viewer connections are established sequentially; local loopback only; results are not WAN latency or production guarantees.",
			"HTTP revocation-response and WebSocket-close times are different observations, not a single security cutoff.",
			"Last observed RTP timestamp is a client-side observation, NOT proof of the final packet ever deliverable.",
			"The quiet window starts 350 ms AFTER the observed WebSocket close; media buffered earlier cannot be revoked.",
			"Pion PeerConnection status at end is a positive control and is not a reliable immediate remote-close timestamp.",
			"No network capture, CPU profiling, concurrent connection admission or confidence intervals.",
		},
	}
	fmt.Printf("SafeStream T-10B | %d WebRTC viewers, 1 revoked, synthetic RTP, loopback only\n", *viewers)
	good := true
	for i := 1; i <= *rounds; i++ {
		fmt.Printf("round %d/%d: connecting viewers...\n", i, *rounds)
		r := runTrial(ctx, api, *sfURL, i, *viewers, *pps, *payload, *quiet)
		result.Rounds = append(result.Rounds, r)
		fmt.Printf("  connected=%d/%d warm=%d/%d http=%.1fms ws-close=%d/%.1fms target-quiet=%d controls=%d/%d result=%v\n", r.ConnectedViewers, *viewers, r.WarmedViewers, *viewers, r.APIRevocationMs, r.MediaWebSocketCloseCode, r.MediaWebSocketCloseMs, r.TargetPacketsDuringQuietWindow, r.OtherViewersReceivingDuringQuietWindow, *viewers-1, r.Passed)
		for _, issue := range r.Issues {
			fmt.Println("  ISSUE:", issue)
		}
		if !r.Passed {
			good = false
			break
		}
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0700); err != nil {
		fmt.Fprintln(os.Stderr, "report directory:", err)
		os.Exit(1)
	}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "marshal report:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, append(encoded, '\n'), 0600); err != nil {
		fmt.Fprintln(os.Stderr, "write report:", err)
		os.Exit(1)
	}
	fmt.Println("Report:", *out)
	if !good {
		fmt.Println("INCOMPLETE/FAIL: inspect JSON; do not commit empirical claims")
		os.Exit(1)
	}
	fmt.Println("OBSERVED: revoked viewer closed with 4003, denied reentry, and other viewers continued receiving RTP during the sampled quiet window")
}
