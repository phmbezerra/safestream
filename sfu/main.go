// SafeStream v0.7: single-publisher, multi-viewer RTP forwarding lab.
// Experimental only: one local machine, one VP8 video stream per room.
// This is NOT a production-ready SFU, identity system, or Discord integration.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/phmbezerra/safestream/sfu/internal/auth"
	"github.com/phmbezerra/safestream/sfu/internal/policy"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

const allowedOrigin = "http://localhost:5173"
const pollInterval = 100 * time.Millisecond // Research parameter, not a guaranteed revocation deadline.

// Lab-only correlation ID. Not a credential, IP address or user identity.
var endpointCounter atomic.Uint64

type envelope struct {
	Type   string `json:"type"`
	RoomID string `json:"roomId,omitempty"`
	Token  string `json:"token,omitempty"`
	SDP    string `json:"sdp,omitempty"`
	Role   string `json:"role,omitempty"`
	Error  string `json:"error,omitempty"`
}

type room struct {
	id        string
	video     *webrtc.TrackLocalStaticRTP
	publisher *client
	clients   map[string]*client
	mu        sync.Mutex
}

type registry struct {
	rooms map[string]*room
	mu    sync.Mutex
}

type client struct {
	id       uint64
	room     *room
	roomID   string
	token    string
	role     string
	socket   *websocket.Conn
	peer     *webrtc.PeerConnection
	registry *registry
	writeMu  sync.Mutex
	once     sync.Once
	closed   chan struct{}
}

func (c *client) send(msg envelope) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.socket.WriteJSON(msg)
}

// T07 audit events record the authorization decision at the media endpoint.
// No session bearer tokens, SDPs, raw RTP payloads or invitation codes are logged.
func (c *client) audit(event string, fields map[string]any) {
	data := map[string]any{
		"schema": "t07-audit-1",
		"at":     time.Now().UTC().Format(time.RFC3339Nano),
		"event":  event, "roomId": c.roomID,
		"endpointId": c.id, "role": c.role,
	}
	for key, value := range fields {
		data[key] = value
	}
	raw, err := json.Marshal(data)
	if err == nil {
		log.Printf("T07_EVENT %s", raw)
	}
}

func (c *client) stop(code int, reason string) {
	c.once.Do(func() {
		close(c.closed)
		c.audit("transport_close_begin", map[string]any{"closeCode": code, "reason": reason})
		// Close the policy-enforcing media endpoint even if the browser ignores notifications.
		// Already delivered RTP, buffers and recordings cannot be revoked retroactively.
		_ = c.peer.Close()
		c.audit("transport_close_complete", map[string]any{"closeCode": code, "reason": reason})
		c.writeMu.Lock()
		_ = c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(500*time.Millisecond))
		c.writeMu.Unlock()
		_ = c.socket.Close()
		c.registry.mu.Lock()
		c.room.mu.Lock()
		delete(c.room.clients, c.token)
		if c.room.publisher == c {
			c.room.publisher = nil
		}
		if len(c.room.clients) == 0 {
			delete(c.registry.rooms, c.roomID)
		}
		c.room.mu.Unlock()
		c.registry.mu.Unlock()
	})
}

func (r *registry) attach(token, roomID, role string, sock *websocket.Conn) (*client, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rm := r.rooms[roomID]
	if rm == nil {
		track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "safestream")
		if err != nil {
			return nil, err
		}
		rm = &room{id: roomID, video: track, clients: make(map[string]*client)}
		r.rooms[roomID] = rm
	}
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if _, exists := rm.clients[token]; exists {
		return nil, errors.New("session already connected")
	}
	if role == "publisher" && rm.publisher != nil {
		return nil, errors.New("room already has a publisher")
	}
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: nil})
	if err != nil {
		return nil, err
	}
	c := &client{id: endpointCounter.Add(1), room: rm, roomID: roomID, role: role, token: token, socket: sock, peer: peer, registry: r, closed: make(chan struct{})}
	if role == "publisher" {
		// SDP will negotiate the browser sending VP8 video to this endpoint.
		if _, err := peer.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo,
			webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			_ = peer.Close()
			return nil, err
		}
		rm.publisher = c
		peer.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			if remote.Kind() != webrtc.RTPCodecTypeVideo {
				return
			}
			// Trigger keyframes for new viewers; does not store or inspect image contents.
			go func() {
				ticker := time.NewTicker(3 * time.Second)
				defer ticker.Stop()
				for {
					select {
					case <-c.closed:
						return
					case <-ticker.C:
						_ = peer.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(remote.SSRC())}})
					}
				}
			}()
			for {
				packet, _, err := remote.ReadRTP()
				if err != nil {
					return
				}
				// WriteRTP forwards to all currently bound viewer transports.
				// On revocation, the server closes the removed viewer's PeerConnection.
				if err := rm.video.WriteRTP(packet); err != nil {
					// No receivers yet is normal; continue reading publisher RTP.
					select {
					case <-c.closed:
						return
					default:
					}
				}
			}
		})
	} else {
		sender, err := peer.AddTrack(rm.video)
		if err != nil {
			_ = peer.Close()
			return nil, err
		}
		go func() { // Drain RTCP feedback from browser.
			buf := make([]byte, 1500)
			for {
				if _, _, err := sender.Read(buf); err != nil {
					return
				}
			}
		}()
	}
	rm.clients[token] = c
	c.audit("media_attached", nil)
	peer.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		c.audit("webrtc_state", map[string]any{"state": s.String()})
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			go c.stop(websocket.CloseNormalClosure, "media connection closed")
		}
	})
	return c, nil
}

// T-08B: authorization outages fail closed, but are NEVER mislabeled revocations.
func (c *client) monitorAccess(v *auth.Validator) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-c.closed:
			cancel()
		case <-ctx.Done():
		}
	}()
	policy.Watch(ctx, pollInterval, 800*time.Millisecond, c.role,
		func(probe context.Context) (string, error) { return v.Check(probe, c.roomID, c.token) },
		func(dec policy.Decision) {
			c.audit(dec.Event, map[string]any{"decision": dec.ReasonKey})
			c.stop(dec.CloseCode, dec.CloseText)
		})
}

func (c *client) acceptOffer(sdp string) error {
	if len(sdp) == 0 || len(sdp) > 64000 {
		return errors.New("invalid SDP length")
	}
	if err := c.peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return err
	}
	answer, err := c.peer.CreateAnswer(nil)
	if err != nil {
		return err
	}
	gather := webrtc.GatheringCompletePromise(c.peer)
	if err := c.peer.SetLocalDescription(answer); err != nil {
		return err
	}
	select {
	case <-gather:
	case <-time.After(10 * time.Second):
		return errors.New("ICE gathering timed out")
	case <-c.closed:
		return errors.New("connection closed")
	}
	return c.send(envelope{Type: "answer", SDP: c.peer.LocalDescription().SDP})
}

func main() {
	base := os.Getenv("SAFESTREAM_NODE_API")
	if base == "" {
		base = "http://127.0.0.1:3001"
	}
	v := auth.NewValidator(base)
	reg := &registry{rooms: make(map[string]*room)}
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == allowedOrigin }}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "lab": true, "media": "webrtc-vp8"})
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		sock, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		sock.SetReadLimit(65536)
		_ = sock.SetReadDeadline(time.Now().Add(10 * time.Second))
		var hello envelope
		if err := sock.ReadJSON(&hello); err != nil || hello.Type != "auth" {
			_ = sock.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "authentication required"), time.Now().Add(time.Second))
			_ = sock.Close()
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		role, err := v.Check(ctx, hello.RoomID, hello.Token)
		cancel()
		if err != nil {
			// T-08B: deny new media admissions during an outage, without claiming revocation.
			code, reason := 4001, "not a room member"
			if !errors.Is(err, auth.ErrUnauthorized) {
				code, reason = 1013, "authorization service unavailable"
			}
			_ = sock.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
			_ = sock.Close()
			return
		}
		c, err := reg.attach(hello.Token, hello.RoomID, role, sock)
		if err != nil {
			_ = sock.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4009, "duplicate media session"), time.Now().Add(time.Second))
			_ = sock.Close()
			return
		}
		_ = sock.SetReadDeadline(time.Time{})
		defer c.stop(websocket.CloseNormalClosure, "client disconnected")
		if err := c.send(envelope{Type: "ready", Role: role}); err != nil {
			return
		}
		go c.monitorAccess(v)
		// Exactly one SDP offer per experimental media connection (no trickle / renegotiation).
		for {
			var msg envelope
			if err := sock.ReadJSON(&msg); err != nil {
				return
			}
			if msg.Type != "offer" {
				_ = c.send(envelope{Type: "error", Error: "only an initial offer is supported"})
				continue
			}
			if err := c.acceptOffer(msg.SDP); err != nil {
				_ = c.send(envelope{Type: "error", Error: "SDP negotiation failed"})
				return
			}
		}
	})
	log.Printf("SafeStream v0.7 WebRTC RTP relay at http://127.0.0.1:3002 (Node API: %s)", base)
	log.Fatal(http.ListenAndServe("127.0.0.1:3002", mux))
}
