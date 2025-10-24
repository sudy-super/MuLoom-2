"""
Prerender job management.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class PrerenderJob:
    scene: str
    codec: str
    params: Dict[str, str]
    output_path: str
    status: str = "queued"
    error: Optional[str] = None


class PrerenderQueue:
    def __init__(self) -> None:
        self.jobs: List[PrerenderJob] = []

    def enqueue(self, job: PrerenderJob) -> None:
        self.jobs.append(job)

    def list_jobs(self) -> List[PrerenderJob]:
        return list(self.jobs)

