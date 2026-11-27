package main

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
    "github.com/pion/webrtc/v4"
)

func TestT14EmergencyStopClosesMediaEndpoints(t *testing.T) {
    var stopped atomic.Bool

    memberships := map[string]map[string]string{
        t09RoomA: {
            t09Alice: "publisher",
            t09Bob: "viewer",
        },
        t09RoomB: {
            t09Diana: "publisher",
        },
    }

    authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodGet ||
            !strings.HasPrefix(r.URL.Path, "/api/rooms/") {
            http.NotFound(w, r)
            return
        }

        roomID := strings.TrimPrefix(r.URL.Path, "/api/rooms/")

        // Simulate Node removing the stopped room.
        if roomID == t09RoomA && stopped.Load() {
            http.NotFound(w, r)
            return
        }

        token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
        role := memberships[roomID][token]

        if role == "" {
            http.Error(w, "not a member", http.StatusForbidden)
            return
        }

        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(map[string]string{
            "roomId": roomID,
            "role": role,
        })
    }))
    defer authority.Close()

    reg := &registry{
        rooms: make(map[string]*room),
    }

    relay := httptest.NewServer(
        newRelayHandler(auth.NewValidator(authority.URL), reg),
    )
    defer relay.Close()

    fixture := t09Fixture{
        base: "ws" + strings.TrimPrefix(relay.URL, "http") + "/ws",
        reg: reg,
    }

    aliceSocket := t09ExpectReady(
        t, fixture, t09RoomA, t09Alice, "publisher", "publisher",
    )
    bobSocket := t09ExpectReady(
        t, fixture, t09RoomA, t09Bob, "viewer", "viewer",
    )
    t09ExpectReady(
        t, fixture, t09RoomB, t09Diana, "publisher", "publisher",
    )

    reg.mu.Lock()
    roomA := reg.rooms[t09RoomA]
    roomB := reg.rooms[t09RoomB]

    roomA.mu.Lock()
    alice := roomA.clients[t09Alice]
    bob := roomA.clients[t09Bob]
    roomA.mu.Unlock()

    roomB.mu.Lock()
    diana := roomB.clients[t09Diana]
    roomB.mu.Unlock()
    reg.mu.Unlock()

    if alice == nil || bob == nil || diana == nil {
        t.Fatal("expected three connected SFU endpoints")
    }

    // Emergency Stop: room A no longer exists in Node.
    stopped.Store(true)

    for _, socket := range []*websocket.Conn{
        aliceSocket,
        bobSocket,
    } {
        _ = socket.SetReadDeadline(time.Now().Add(3 * time.Second))

        var message envelope
        err := socket.ReadJSON(&message)

        var closeError *websocket.CloseError
        if !errors.As(err, &closeError) || closeError.Code != 4003 {
            t.Fatalf(
                "expected authorization closure 4003; got %v",
                err,
            )
        }
    }

    // Server-owned PeerConnections must actually close.
    for _, client := range []*client{alice, bob} {
        select {
        case <-client.closed:
        case <-time.After(2 * time.Second):
            t.Fatal("SFU endpoint did not terminate")
        }

        if client.peer.ConnectionState() != webrtc.PeerConnectionStateClosed {
            t.Fatal("SFU PeerConnection remained open")
        }
    }

    // An unrelated room must remain connected.
    select {
    case <-diana.closed:
        t.Fatal("emergency stop affected an unrelated room")
    default:
    }
}
