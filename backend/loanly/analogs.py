"""Module 5 (METHODS 5): "which past season does this one look like?"  (nearest-neighbour analogs)

For week t we compare this season's anomaly series up to t -- NDVI z-score, SPI-60 and soil-moisture percentile (standardised to
a z-like scale) -- with every history season over the same weeks, using the Euclidean distance (root-mean-square per week and
indicator, so distances are comparable across weeks). The closest 3 seasons are the analogs; each is reported with its
department yield anomaly, which gives the banker a plain-language comparison ("looks like 2008/09, when yields fell 42 %").
"""
from __future__ import annotations

import numpy as np

from . import config as C

H, CUR = C.N_HIST, C.CUR


def compute(ndvi_z, spi60, sm_pct, dept_anom: np.ndarray, k: int = 3) -> dict:
    """Inputs (F,S,W) and dept_anom (F,H). Returns idx (F,k,W) history-season indices, dist (F,k,W), yanom (F,k,W)."""
    a = np.stack([np.clip(ndvi_z, -3, 3), np.clip(spi60, -3, 3), (sm_pct - 50.0) / 28.87], axis=-1)       # (F,S,W,3)
    d2 = ((a[:, CUR][:, None] - a[:, :H]) ** 2).sum(-1)                                                    # (F,H,W)
    cum = np.cumsum(d2, axis=2)
    n = (np.arange(C.W) + 1) * 3.0
    dist = np.sqrt(cum / n[None, None, :])
    idx = np.argsort(dist, axis=1)[:, :k, :]
    d = np.take_along_axis(dist, idx, 1)
    ya = np.take_along_axis(np.broadcast_to(dept_anom[:, :, None], dist.shape), idx, 1)
    return dict(idx=idx, dist=d, yanom=ya)
