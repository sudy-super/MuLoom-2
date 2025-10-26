import pytest

from engine.timeline import InvalidCommand, RevisionMismatch, TimelineTransport


class FakeClock:
    def __init__(self) -> None:
        self.value = 0

    def now(self) -> int:
        return self.value

    def advance_us(self, delta: int) -> None:
        self.value += int(delta)


def test_initial_snapshot() -> None:
    clock = FakeClock()
    timeline = TimelineTransport(monotonic=clock.now)

    snapshot = timeline.snapshot()
    assert snapshot.rev == 0
    assert snapshot.playing is False
    assert snapshot.rate == 1.0
    assert snapshot.pos_us == 0
    assert snapshot.t0_us == 0


def test_play_pause_cycle() -> None:
    clock = FakeClock()
    timeline = TimelineTransport(monotonic=clock.now)

    snap_play = timeline.play()
    assert snap_play.playing is True
    assert snap_play.rev == 1

    clock.advance_us(2_000_000)
    assert timeline.now_position_us() == 2_000_000

    snap_pause = timeline.pause()
    assert snap_pause.rev == 2
    assert snap_pause.playing is False
    assert snap_pause.pos_us == 2_000_000
    assert snap_pause.t0_us == clock.value

    # Resume should keep the last known position as base.
    clock.advance_us(1_000_000)
    snap_resume = timeline.play(expected_rev=snap_pause.rev)
    assert snap_resume.rev == 3
    assert snap_resume.pos_us == 2_000_000
    clock.advance_us(500_000)
    assert timeline.now_position_us() == 2_500_000


def test_seek_and_rate_change() -> None:
    clock = FakeClock()
    timeline = TimelineTransport(monotonic=clock.now)

    snap_seek = timeline.seek(5_500_000)
    assert snap_seek.rev == 1
    assert snap_seek.playing is False
    assert snap_seek.pos_us == 5_500_000

    snap_play = timeline.play()
    assert snap_play.playing is True
    clock.advance_us(1_000_000)
    assert timeline.now_position_us() == 6_500_000

    snap_rate = timeline.set_rate(2.0)
    assert snap_rate.rev == 3
    assert snap_rate.rate == 2.0
    assert snap_rate.pos_us == 6_500_000

    clock.advance_us(500_000)
    assert timeline.now_position_us() == 7_500_000


def test_revision_mismatch() -> None:
    timeline = TimelineTransport()
    with pytest.raises(RevisionMismatch):
        timeline.pause(expected_rev=42)


def test_invalid_command() -> None:
    timeline = TimelineTransport()
    with pytest.raises(InvalidCommand):
        timeline.apply("invalid-op")


def test_subscribe_receives_updates() -> None:
    clock = FakeClock()
    timeline = TimelineTransport(monotonic=clock.now)

    received = []

    def observer(snapshot):
        received.append(snapshot.rev)

    token = timeline.subscribe(observer)
    assert received == [0]

    timeline.play()
    timeline.pause()
    assert received == [0, 1, 2]

    timeline.unsubscribe(token)
    timeline.play()
    assert received == [0, 1, 2]
