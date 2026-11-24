package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const testRoom = "abcdefghijkl"
const testToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestAllowedMemberAndRevocation(t *testing.T) {
	var revoked atomic.Bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/rooms/"+testRoom || r.Header.Get("Authorization") != "Bearer "+testToken || revoked.Load() {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"roomId": testRoom, "role": "viewer"})
	}))
	defer ts.Close()
	v := NewValidator(ts.URL)
	if role, err := v.Check(context.Background(), testRoom, testToken); err != nil || role != "viewer" {
		t.Fatalf("expected viewer, got %q / %v", role, err)
	}
	revoked.Store(true)
	if _, err := v.Check(context.Background(), testRoom, testToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected revocation denial, got %v", err)
	}
}

func TestRejectMalformedTokensAndUnexpectedRoles(t *testing.T) {
	var requests atomic.Int64
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"roomId":"abcdefghijkl","role":"admin"}`))
	}))
	defer ts.Close()
	v := NewValidator(ts.URL)
	for _, input := range []struct{ room, token string }{
		{"../../evil", testToken}, {testRoom, "bad"}, {testRoom, strings.Repeat("a", 64)},
	} {
		if _, err := v.Check(context.Background(), input.room, input.token); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("invalid input allowed: %+v (%v)", input, err)
		}
	}
	if requests.Load() != 0 {
		t.Fatal("malformed inputs must not reach API")
	}
	if _, err := v.Check(context.Background(), testRoom, testToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unexpected role accepted: %v", err)
	}
}
