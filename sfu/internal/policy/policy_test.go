package policy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/phmbezerra/safestream/sfu/internal/auth"
)

const testRoom = "abcdefghijkl"
const testToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestClassify(t *testing.T) {
	cases := []struct {
		name, actual  string
		err           error
		blocked       bool
		code          int
		event, reason string
	}{
		{name: "authorized", actual: "viewer"},
		{name: "revoked", err: auth.ErrUnauthorized, blocked: true, code: 4003, event: "authorization_rejected", reason: "membership_denied"},
		{name: "unavailable", err: auth.ErrUnavailable, blocked: true, code: 1013, event: "authorization_unavailable", reason: "authorization_api_unavailable"},
		{name: "role changed", actual: "publisher", blocked: true, code: 4003, event: "authorization_rejected", reason: "role_mismatch"},
		{name: "unexpected error", err: errors.New("network error"), blocked: true, code: 1013, event: "authorization_unavailable", reason: "authorization_api_unavailable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, blocked := Classify("viewer", tc.actual, tc.err)
			if blocked != tc.blocked || got.CloseCode != tc.code || got.Event != tc.event || got.ReasonKey != tc.reason {
				t.Fatalf("got blocked=%v decision=%+v", blocked, got)
			}
		})
	}
}

// The watch tests exercise actual HTTP checks against a mock Node API, not
// just a synthetic error passed directly to Classify.
func TestWatchDifferentiatesOutageFromRevocation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		code   int
		event  string
	}{
		{"outage HTTP 503", 503, 1013, "authorization_unavailable"},
		{"revoked HTTP 403", 403, 4003, "authorization_rejected"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var responseCode atomic.Int32
			responseCode.Store(200)
			healthyObserved := make(chan struct{}, 1)
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/rooms/"+testRoom || r.Header.Get("Authorization") != "Bearer "+testToken {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				status := int(responseCode.Load())
				if status != 200 {
					w.WriteHeader(status)
					return
				}
				select {
				case healthyObserved <- struct{}{}:
				default:
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"roomId":"abcdefghijkl","role":"viewer"}`))
			}))
			defer api.Close()
			v := auth.NewValidator(api.URL)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			decisions := make(chan Decision, 1)
			completed := make(chan struct{})
			go func() {
				defer close(completed)
				Watch(ctx, 5*time.Millisecond, 100*time.Millisecond, "viewer", func(ctx context.Context) (string, error) {
					return v.Check(ctx, testRoom, testToken)
				}, func(d Decision) { decisions <- d })
			}()
			select {
			case <-healthyObserved:
			case <-time.After(2 * time.Second):
				t.Fatal("healthy check did not occur")
			}
			responseCode.Store(int32(tc.status))
			select {
			case got := <-decisions:
				if got.CloseCode != tc.code || got.Event != tc.event {
					t.Fatalf("wrong action for %d: %+v", tc.status, got)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("watch did not fail closed")
			}
			select {
			case <-completed:
			case <-time.After(time.Second):
				t.Fatal("watch did not terminate")
			}
		})
	}
}

func TestWatchCancellationDoesNotRevoke(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	called := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		Watch(ctx, time.Millisecond, 50*time.Millisecond, "viewer", func(ctx context.Context) (string, error) {
			cancel()
			return "", ctx.Err()
		}, func(Decision) { called <- struct{}{} })
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("did not finish")
	}
	select {
	case <-called:
		t.Fatal("cancel incorrectly caused revocation")
	default:
	}
}
