package main

// T-09: verify actual Pion relay WebSocket admissions and room-scoped tracks.
// This is a local control-plane/track-separation test, not a decoded-RTP proof.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/phmbezerra/safestream/sfu/internal/auth"
)

const (
	t09RoomA = "AAAAAAAAAAAA"
	t09RoomB = "BBBBBBBBBBBB"
	t09Alice = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	t09Bob   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	t09Diana = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
	t09Carol = "cccccccccccccccccccccccccccccccc"
	t09Eve   = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"
)

type t09Fixture struct {
	base    string
	reg     *registry
	revoked *atomic.Bool
}

func newT09Fixture(t *testing.T) t09Fixture {
	t.Helper()
	revoked := &atomic.Bool{}
	memberships := map[string]map[string]string{
		t09RoomA: {t09Alice: "publisher", t09Bob: "viewer"},
		// Alice is legitimately a publisher in A but only a viewer in B.
		t09RoomB: {t09Diana: "publisher", t09Carol: "viewer", t09Alice: "viewer"},
	}
	authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/api/rooms/") {
			http.NotFound(w, r)
			return
		}
		roomID := strings.TrimPrefix(r.URL.Path, "/api/rooms/")
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		role := memberships[roomID][token]
		if roomID == t09RoomA && token == t09Bob && revoked.Load() {
			role = ""
		}
		if role == "" {
			http.Error(w, "not a room member", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"roomId": roomID, "role": role})
	}))
	t.Cleanup(authority.Close)
	reg := &registry{rooms: make(map[string]*room)}
	relay := httptest.NewServer(newRelayHandler(auth.NewValidator(authority.URL), reg))
	t.Cleanup(relay.Close)
	return t09Fixture{
		base:    "ws" + strings.TrimPrefix(relay.URL, "http") + "/ws",
		reg:     reg,
		revoked: revoked,
	}
}

func t09Connect(t *testing.T, f t09Fixture, roomID, token, claimedRole string) (*websocket.Conn, envelope, error) {
	t.Helper()
	header := http.Header{"Origin": []string{allowedOrigin}}
	socket, _, err := websocket.DefaultDialer.Dial(f.base, header)
	if err != nil {
		t.Fatalf("WebSocket dial failed: %v", err)
	}
	t.Cleanup(func() { _ = socket.Close() })
	if err := socket.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := socket.WriteJSON(envelope{Type: "auth", RoomID: roomID, Token: token, Role: claimedRole}); err != nil {
		t.Fatalf("auth send: %v", err)
	}
	var response envelope
	err = socket.ReadJSON(&response)
	return socket, response, err
}

func t09ExpectDenied(t *testing.T, f t09Fixture, room, token string) {
	t.Helper()
	_, got, err := t09Connect(t, f, room, token, "publisher")
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != 4001 {
		t.Fatalf("cross-room admission: expected WebSocket 4001, got response=%+v err=%v", got, err)
	}
}

func t09ExpectReady(t *testing.T, f t09Fixture, room, token, claimedRole, expectedRole string) *websocket.Conn {
	t.Helper()
	socket, got, err := t09Connect(t, f, room, token, claimedRole)
	if err != nil || got.Type != "ready" || got.Role != expectedRole {
		t.Fatalf("expected ready role=%s, got response=%+v err=%v", expectedRole, got, err)
	}
	return socket
}

func TestT09CrossRoomPionAdmissionAndRoleSpoofing(t *testing.T) {
	f := newT09Fixture(t)
	t09ExpectDenied(t, f, t09RoomB, t09Bob)
	t09ExpectDenied(t, f, t09RoomA, t09Carol)
	t09ExpectDenied(t, f, t09RoomA, t09Eve)
	t09ExpectDenied(t, f, t09RoomB, t09Eve)

	t09ExpectReady(t, f, t09RoomA, t09Alice, "viewer", "publisher")
	t09ExpectReady(t, f, t09RoomA, t09Bob, "publisher", "viewer")
	t09ExpectReady(t, f, t09RoomB, t09Diana, "viewer", "publisher")
	t09ExpectReady(t, f, t09RoomB, t09Carol, "publisher", "viewer")
	// A global session token may have different verified roles in each room.
	t09ExpectReady(t, f, t09RoomB, t09Alice, "publisher", "viewer")

	f.reg.mu.Lock()
	a, b := f.reg.rooms[t09RoomA], f.reg.rooms[t09RoomB]
	if a == nil || b == nil {
		f.reg.mu.Unlock()
		t.Fatal("expected both rooms")
	}
	if a == b || a.video == b.video {
		f.reg.mu.Unlock()
		t.Fatal("separate rooms must have separate RTP track instances")
	}
	if a.clients[t09Bob] == nil || b.clients[t09Bob] != nil {
		f.reg.mu.Unlock()
		t.Fatal("Bob must only be attached to room A")
	}
	if b.clients[t09Carol] == nil || a.clients[t09Carol] != nil {
		f.reg.mu.Unlock()
		t.Fatal("Carol must only be attached to room B")
	}
	f.reg.mu.Unlock()
}

func TestT09RevokingRoomADoesNotTerminateRoomB(t *testing.T) {
	f := newT09Fixture(t)
	t09ExpectReady(t, f, t09RoomA, t09Alice, "publisher", "publisher")
	bob := t09ExpectReady(t, f, t09RoomA, t09Bob, "viewer", "viewer")
	t09ExpectReady(t, f, t09RoomB, t09Diana, "publisher", "publisher")
	t09ExpectReady(t, f, t09RoomB, t09Carol, "viewer", "viewer")

	f.reg.mu.Lock()
	carol := f.reg.rooms[t09RoomB].clients[t09Carol]
	f.reg.mu.Unlock()
	if carol == nil {
		t.Fatal("missing Carol")
	}
	f.revoked.Store(true)
	if err := bob.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var msg envelope
	err := bob.ReadJSON(&msg)
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != 4003 {
		t.Fatalf("expected 4003 for revoked Bob; got %+v %v", msg, err)
	}
	// After multiple polling cycles, B must remain untouched by A's revocation.
	time.Sleep(400 * time.Millisecond)
	select {
	case <-carol.closed:
		t.Fatal("Carol in room B was closed by room A revocation")
	default:
	}
	f.reg.mu.Lock()
	stillPresent := f.reg.rooms[t09RoomB] != nil && f.reg.rooms[t09RoomB].clients[t09Carol] == carol
	f.reg.mu.Unlock()
	if !stillPresent {
		t.Fatal("Carol should remain connected in room B")
	}
}
