"""Regression tests for differences in platform capabilities.

Two things must hold:
1. On macOS, `CC-Monitor verify` must not print a green verdict such as "No suspicious records":
   that check never runs on macOS (the probe uses nettop and cannot see execve), so saying
   "passed" gives a false sense of safety.
2. The Linux probe's bpftrace script must handle both AF_INET and AF_INET6; otherwise machines with
   IPv6 enabled have a silent blind spot in network observation.

Run directly: python3 -m unittest tests/test_platform_caps.py
"""
import io
import os
import re
import sys
import tempfile
import unittest
from unittest import mock

_TMP = tempfile.mkdtemp(prefix="cc-monitor-test-")
os.environ["CC_MONITOR_HOME"] = _TMP
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO)

from cc_monitor import cli  # noqa: E402

BT_PATH = os.path.join(_REPO, "cc_monitor", "probe_linux.bt")


class Args:
    limit = 100


def run_verify_on(system_name):
    buf = io.StringIO()
    with mock.patch("cc_monitor.cli.platform.system", return_value=system_name), \
         mock.patch("sys.stdout", buf):
        cli.cmd_verify(Args())
    return buf.getvalue()


class TestVerifyPlatformHonesty(unittest.TestCase):
    def test_macos_does_not_claim_a_clean_result(self):
        out = run_verify_on("Darwin")
        self.assertIn("does not support the execution-layer cross-check", out)
        # The most important one: "No suspicious records" must never appear; only Linux can say that.
        self.assertNotIn("No suspicious records", out)

    def test_macos_explains_what_still_works(self):
        out = run_verify_on("Darwin")
        self.assertIn("hook", out.lower())

    def test_linux_still_reports_normally(self):
        out = run_verify_on("Linux")
        self.assertNotIn("does not support the execution-layer cross-check", out)
        self.assertIn("No suspicious records", out)


class TestProbeCoversIPv6(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bt = io.open(BT_PATH, encoding="utf-8").read()

    def test_connect_handles_both_address_families(self):
        """Both families, AF_INET=2 and AF_INET6=10, need a branch."""
        self.assertIn("sa_family == 2", self.bt)
        self.assertIn("sa_family == 10", self.bt)

    def test_connect_formats_the_v6_address(self):
        """A v6 address is a 16-byte array; it must be read through sockaddr_in6, not patched together from the v4 s_addr."""
        self.assertIn("sockaddr_in6", self.bt)
        self.assertIn("sin6_addr", self.bt)
        self.assertIn("sin6_port", self.bt)

    def test_byte_counters_use_the_v6_destination(self):
        """On an IPv6 socket skc_daddr is 0, so traffic must take its destination from skc_v6_daddr;
        otherwise all v6 bytes sent and received pile up on the fake address 0.0.0.0."""
        self.assertIn("skc_v6_daddr", self.bt)
        self.assertEqual(
            self.bt.count("skc_family == 10"), 2,
            "Both probe points, tcp_sendmsg and tcp_cleanup_rbuf, must cover IPv6",
        )

    def test_v6_output_still_matches_the_bytes_map_parser(self):
        """The aggregate map lines the probe prints must be recognised by probe.py's regex. IPv6
        addresses contain colons, so make sure the parser does not trip over them."""
        from cc_monitor.probe import _BYTES_MAP_LINE

        m = _BYTES_MAP_LINE.match("@tx_bytes[2606:4700:4700::1111, 443]: 725")
        self.assertIsNotNone(m, "Traffic stat lines with IPv6 addresses must be parseable")
        self.assertEqual(m.group(2), "2606:4700:4700::1111")
        self.assertEqual(m.group(3), "443")
        self.assertEqual(m.group(4), "725")


if __name__ == "__main__":
    unittest.main()
