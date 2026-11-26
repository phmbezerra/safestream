package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestLoopbackOnlyEndpoints(t *testing.T) {
	tests := []struct {
		url, scheme string
		allowed     bool
	}{
		{"http://127.0.0.1:3101", "http", true},
		{"http://localhost:3101", "http", true},
		{"ws://127.0.0.1:3002/ws", "ws", true},
		{"ws://[::1]:3002/ws", "ws", true},
		{"https://example.org", "http", false},
		{"http://example.org", "http", false},
		{"ws://192.168.1.10:3002/ws", "ws", false},
		{"ws://user:pass@127.0.0.1:3002/ws", "ws", false},
		{"ws://127.0.0.1:3002/ws?token=secret", "ws", false},
	}
	for _, tt := range tests {
		err := loopbackURL(tt.url, tt.scheme)
		if (err == nil) != tt.allowed {
			t.Errorf("loopbackURL(%q,%q) err=%v allowed=%v", tt.url, tt.scheme, err, tt.allowed)
		}
	}
}

func TestReadmissionDeniedByClose4001(t *testing.T) {
	u := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == origin }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := u.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var received envelope
		if err := ws.ReadJSON(&received); err != nil {
			return
		}
		if received.Type != "auth" || received.RoomID != "abcdefghijkl" {
			return
		}
		_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "not a room member"), time.Now().Add(time.Second))
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	got, err := readmissionDenied(context.Background(), url, "abcdefghijkl", account{Secret: strings.Repeat("x", 32)})
	if err != nil || !got {
		t.Fatalf("expected WS close 4001, got=%v err=%v", got, err)
	}
}

func TestMemberHTTPForbiddenAfterRevocation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/api/rooms/") {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	api := clientAPI{base: server.URL, http: server.Client()}
	ok, err := api.deniedMembership(context.Background(), "abcdefghijkl", account{Secret: strings.Repeat("x", 32)})
	if err != nil || !ok {
		t.Fatalf("expected HTTP 403, got=%v err=%v", ok, err)
	}
}

func TestReportNeverSerializesBearerSecrets(t *testing.T) {
	secret := strings.Repeat("s", 32)
	r := report{SchemaVersion: "t10b-1", Rounds: []trialResult{{Round: 1, Issues: []string{"sample"}}}}
	encoded, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), secret) || strings.Contains(string(encoded), "secret") || strings.Contains(string(encoded), "token") {
		t.Fatalf("unexpected credential-like field in report")
	}
}
