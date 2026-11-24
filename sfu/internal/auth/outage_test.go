package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAuthorizationAPIStatusClassification(t *testing.T) {
	const room = "abcdefghijkl"
	const bearer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	for _, tc := range []struct {
		status int
		want   error
	}{
		{http.StatusForbidden, ErrUnauthorized},
		{http.StatusUnauthorized, ErrUnauthorized},
		{http.StatusNotFound, ErrUnauthorized},
		{http.StatusServiceUnavailable, ErrUnavailable},
		{http.StatusInternalServerError, ErrUnavailable},
		{http.StatusTooManyRequests, ErrUnavailable},
	} {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status) }))
			defer api.Close()
			_, err := NewValidator(api.URL).Check(context.Background(), room, bearer)
			if !errors.Is(err, tc.want) {
				t.Fatalf("status %d: got %v, want %v", tc.status, err, tc.want)
			}
		})
	}
}

func TestAuthorizationTimeoutFailsClosedAsUnavailable(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer api.Close()
	v := NewValidator(api.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
	defer cancel()
	_, err := v.Check(ctx, "abcdefghijkl", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("timeout classified as %v", err)
	}
}

func TestInvalidSuccessfulResponseIsUnavailable(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{invalid`)) }))
	defer api.Close()
	_, err := NewValidator(api.URL).Check(context.Background(), "abcdefghijkl", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("malformed JSON classified as %v", err)
	}
}
