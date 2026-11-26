package main

import (
	"math"
	"testing"
)

func TestPercentileLinearInterpolation(t *testing.T) {
	data := []float64{50, 10, 20, 30, 40}
	cases := []struct{ q, want float64 }{{0, 10}, {.5, 30}, {.95, 48}, {.99, 49.6}, {1, 50}}
	for _, tc := range cases {
		got := percentile(data, tc.q)
		if math.Abs(got-tc.want) > .000001 {
			t.Fatalf("q=%v got %v want %v", tc.q, got, tc.want)
		}
	}
	if percentile(nil, .95) != 0 {
		t.Fatal("empty percentile")
	}
}
func TestParseLoadLevels(t *testing.T) {
	if _, err := parseLevels("1,2,5,10,20"); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"0", "21", "1,1", "", "1,2,3,4,5,6", "2,x"} {
		if _, err := parseLevels(s); err == nil {
			t.Fatalf("accepted %q", s)
		}
	}
}
func TestLoopbackOnly(t *testing.T) {
	for _, s := range []string{"http://127.0.0.1:3101", "http://localhost:3101", "http://[::1]:3101"} {
		if err := loopbackURL(s, "http"); err != nil {
			t.Fatal(s, err)
		}
	}
	for _, s := range []string{"http://example.org:3101", "http://192.168.1.20:3101", "https://localhost", "http://localhost:3101/?secret=1", "http://user:pwd@localhost:3101"} {
		if err := loopbackURL(s, "http"); err == nil {
			t.Fatalf("accepted %q", s)
		}
	}
}
