"""Person detection, ankle pose estimation, and appearance descriptors for Player Tracking.

Part of Tracking (ADR 0001, ADR 0012): Event Processing never reads this.

Uses Apache-2.0 / BSD PyTorch models downloaded on first run into the `platformdirs` user cache
directory, selecting CUDA, Apple MPS, or CPU automatically at runtime (or obeying an explicit
override). PyTorch and Transformers are imported lazily so CLI startup and offline unit tests stay
fast without GPU frameworks loaded.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal, Protocol

import cv2
import numpy as np
import platformdirs

from pb_tokei.rally_log import ImagePoint
from pb_tokei.state import APP_NAME

DEFAULT_DETECTOR_MODEL_ID = "ustc-community/dfine-small-coco"
"""Apache-2.0 real-time DETR person detector (D-FINE-S, 41.5 MB)."""

DEFAULT_POSE_MODEL_ID = "usyd-community/vitpose-plus-small"
"""Apache-2.0 ViTPose+-Small pose estimator (fused to COCO expert 0 at load time)."""

MODEL_CACHE_ENV = "PB_TOKEI_MODEL_CACHE_DIR"

MIN_DETECTION_SCORE = 0.30
"""Minimum detector person confidence kept in Layer 1."""

MIN_POSE_CANDIDATE_HEIGHT = 0.06
"""Minimum normalised person box height eligible for pose estimation (drops distant crowd heads)."""

MAX_POSE_CANDIDATES_PER_FRAME = 10
"""Maximum person crops per sampled frame sent through ViTPose (always covers 4 Players + refs)."""

MIN_ANKLE_CONFIDENCE = 0.30
"""Minimum ViTPose ankle heatmap confidence to trust ankle localisation over bbox fallback."""

BOTTOM_EDGE_CROP_MARGIN = 0.015
"""When ankles are unconfident and bbox bottom `y2 >= 1 - margin`, feet are treated as cropped."""

DUPLICATE_IOU_THRESHOLD = 0.75
"""Suppresses near-identical duplicate person detections from the same frame."""

APPEARANCE_DIM = 48
"""Fixed length of the L2-normalised 3-band HSV appearance descriptor (16 dims × 3 bands)."""

_COCO_LEFT_ANKLE = 15
_COCO_RIGHT_ANKLE = 16
_DETECTOR_INPUT_SIZE = 640
_POSE_CROP_W = 192
_POSE_CROP_H = 256
_POSE_PAD_SCALE = 1.25
_POSE_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 1, 3)
_POSE_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 1, 3)

DevicePreference = Literal["auto", "cuda", "mps", "cpu"]
VALID_DEVICE_PREFERENCES: tuple[DevicePreference, ...] = ("auto", "mps", "cuda", "cpu")


class DeviceKind(StrEnum):
    CUDA = "cuda"
    MPS = "mps"
    CPU = "cpu"


class PlayerTrackingError(RuntimeError):
    """Raised when Player Tracking cannot run (missing video, device, or model error)."""


def default_model_cache_dir() -> Path:
    """User cache directory for downloaded model weights, overridable via env var."""
    override = os.environ.get(MODEL_CACHE_ENV)
    if override:
        return Path(override)
    return Path(platformdirs.user_cache_dir(APP_NAME)) / "models"


def select_device(preference: DevicePreference = "auto") -> DeviceKind:
    """Picks CUDA, Apple MPS, or CPU at runtime, honoring an explicit override."""
    if preference not in VALID_DEVICE_PREFERENCES:
        raise ValueError(
            f"Invalid device {preference!r}; expected one of {', '.join(VALID_DEVICE_PREFERENCES)}"
        )
    import torch

    cuda_ok = bool(torch.cuda.is_available())
    mps_backend = getattr(torch.backends, "mps", None)
    mps_ok = bool(mps_backend is not None and mps_backend.is_available())

    if preference == "auto":
        if cuda_ok:
            return DeviceKind.CUDA
        if mps_ok:
            return DeviceKind.MPS
        return DeviceKind.CPU
    if preference == "cuda":
        if not cuda_ok:
            raise PlayerTrackingError("Requested device 'cuda', but CUDA is not available")
        return DeviceKind.CUDA
    if preference == "mps":
        if not mps_ok:
            raise PlayerTrackingError("Requested device 'mps', but Apple MPS is not available")
        return DeviceKind.MPS
    return DeviceKind.CPU


@dataclass(frozen=True)
class RawDetection:
    """One person detected on a video frame, in normalised image coordinates [0, 1]."""

    x1: float
    y1: float
    x2: float
    y2: float
    score: float
    left_ankle: tuple[float, float, float] | None = None
    right_ankle: tuple[float, float, float] | None = None
    appearance: np.ndarray | None = None

    def foot_point(
        self,
        *,
        min_ankle_conf: float = MIN_ANKLE_CONFIDENCE,
        bottom_crop_margin: float = BOTTOM_EDGE_CROP_MARGIN,
    ) -> tuple[ImagePoint, bool, bool]:
        """Returns `(foot_image_point, ankles_visible, feet_cropped)`.

        Uses the midpoint of both confident ankles, or a single confident ankle if only one is
        visible. Falls back to the bounding-box bottom-centre when ankles are absent/low-confidence,
        flagging `feet_cropped=True` if the box is clipped against the bottom edge of the frame.
        """
        left_ok = (
            self.left_ankle is not None
            and np.isfinite(self.left_ankle[0])
            and np.isfinite(self.left_ankle[1])
            and self.left_ankle[2] >= min_ankle_conf
        )
        right_ok = (
            self.right_ankle is not None
            and np.isfinite(self.right_ankle[0])
            and np.isfinite(self.right_ankle[1])
            and self.right_ankle[2] >= min_ankle_conf
        )
        if left_ok and right_ok and self.left_ankle is not None and self.right_ankle is not None:
            fx = _clamp01(0.5 * (self.left_ankle[0] + self.right_ankle[0]))
            fy = _clamp01(0.5 * (self.left_ankle[1] + self.right_ankle[1]))
            return ImagePoint(fx, fy), True, False
        if left_ok and self.left_ankle is not None:
            return (
                ImagePoint(_clamp01(self.left_ankle[0]), _clamp01(self.left_ankle[1])),
                True,
                False,
            )
        if right_ok and self.right_ankle is not None:
            return (
                ImagePoint(_clamp01(self.right_ankle[0]), _clamp01(self.right_ankle[1])),
                True,
                False,
            )
        cropped = self.y2 >= 1.0 - bottom_crop_margin
        fx = _clamp01(0.5 * (self.x1 + self.x2))
        fy = _clamp01(self.y2)
        return ImagePoint(fx, fy), False, cropped


class VisionBackend(Protocol):
    """Interface for Layer 1 person detection + ankle pose + appearance extraction."""

    detector_model: str
    pose_model: str
    device: DeviceKind

    def detect_batch(self, frames_bgr: Sequence[np.ndarray]) -> list[tuple[RawDetection, ...]]:
        """Runs person detection, ankle pose, and appearance extraction on a batch of BGR frames."""
        ...


def extract_appearance_embedding(
    frame_bgr: np.ndarray, x1: float, y1: float, x2: float, y2: float
) -> np.ndarray:
    """Computes an L2-normalised 48-dim 3-band HSV appearance descriptor for a person box.

    Samples the inner horizontal half (`[0.25, 0.75]`) across three vertical bands — upper torso
    (jersey), lower body (shorts/skirt), and lower legs/shoes — weighting Hue by Saturation so
    achromatic white/black/grey kits remain stable and distinct.
    """
    h, w = frame_bgr.shape[:2]
    if h <= 0 or w <= 0:
        return np.zeros(APPEARANCE_DIM, dtype=np.float32)

    px1 = max(0, min(w - 1, int(round(x1 * w))))
    px2 = max(px1 + 1, min(w, int(round(x2 * w))))
    py1 = max(0, min(h - 1, int(round(y1 * h))))
    py2 = max(py1 + 1, min(h, int(round(y2 * h))))
    bw = px2 - px1
    bh = py2 - py1
    if bw < 2 or bh < 4:
        return np.zeros(APPEARANCE_DIM, dtype=np.float32)

    # Narrow to the inner horizontal body column to avoid court surface around the silhouette.
    ix1 = px1 + int(round(bw * 0.25))
    ix2 = max(ix1 + 1, px1 + int(round(bw * 0.75)))

    bands = (
        (0.15, 0.50, 1.0),  # upper torso / jersey
        (0.50, 0.78, 0.9),  # shorts / skirt
        (0.78, 0.98, 0.5),  # lower legs / shoes
    )
    parts: list[np.ndarray] = []
    for f_top, f_bot, weight in bands:
        by1 = py1 + int(round(bh * f_top))
        by2 = max(by1 + 1, py1 + int(round(bh * f_bot)))
        crop = frame_bgr[by1:by2, ix1:ix2]
        if crop.size == 0:
            parts.append(np.zeros(16, dtype=np.float32))
            continue
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        hue = hsv[:, :, 0].ravel()
        sat = hsv[:, :, 1].ravel()
        val = hsv[:, :, 2].ravel()
        sat_w = sat.astype(np.float32) / 255.0

        h_hist, _ = np.histogram(hue, bins=8, range=(0, 180), weights=sat_w)
        s_hist, _ = np.histogram(sat, bins=4, range=(0, 256))
        v_hist, _ = np.histogram(val, bins=4, range=(0, 256))

        h_vec = h_hist.astype(np.float32)
        s_vec = s_hist.astype(np.float32)
        v_vec = v_hist.astype(np.float32)
        if h_vec.sum() > 0:
            h_vec /= h_vec.sum()
        if s_vec.sum() > 0:
            s_vec /= s_vec.sum()
        if v_vec.sum() > 0:
            v_vec /= v_vec.sum()
        parts.append(np.concatenate([h_vec * 1.4, s_vec * 0.8, v_vec * 1.0]) * weight)

    vec = np.concatenate(parts).astype(np.float32)
    norm = float(np.linalg.norm(vec))
    if norm > 1e-6:
        vec /= norm
    return vec


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, float(value)))


def _box_iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    denom = area_a + area_b - inter
    return inter / denom if denom > 0.0 else 0.0


def _suppress_duplicates(
    boxes: list[tuple[float, float, float, float, float]],
    iou_threshold: float = DUPLICATE_IOU_THRESHOLD,
) -> list[tuple[float, float, float, float, float]]:
    ordered = sorted(boxes, key=lambda item: item[4], reverse=True)
    kept: list[tuple[float, float, float, float, float]] = []
    for box in ordered:
        coords = (box[0], box[1], box[2], box[3])
        if all(_box_iou(coords, (k[0], k[1], k[2], k[3])) <= iou_threshold for k in kept):
            kept.append(box)
    return kept


def _extract_pose_crop(
    frame_bgr: np.ndarray,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    """Extracts a 192×256 ViTPose person crop and returns `(CHW float32, (cx, cy, bw, bh))`."""
    h, w = frame_bgr.shape[:2]
    px1, py1, px2, py2 = x1 * w, y1 * h, x2 * w, y2 * h
    bw = max(1.0, px2 - px1)
    bh = max(1.0, py2 - py1)
    cx = 0.5 * (px1 + px2)
    cy = 0.5 * (py1 + py2)
    aspect = _POSE_CROP_W / _POSE_CROP_H
    if bw > aspect * bh:
        bh = bw / aspect
    else:
        bw = bh * aspect
    bw *= _POSE_PAD_SCALE
    bh *= _POSE_PAD_SCALE

    src = np.array(
        [
            [cx - 0.5 * bw, cy - 0.5 * bh],
            [cx + 0.5 * bw, cy - 0.5 * bh],
            [cx - 0.5 * bw, cy + 0.5 * bh],
        ],
        dtype=np.float32,
    )
    dst = np.array([[0.0, 0.0], [_POSE_CROP_W, 0.0], [0.0, _POSE_CROP_H]], dtype=np.float32)
    affine = cv2.getAffineTransform(src, dst)
    warped = cv2.warpAffine(frame_bgr, affine, (_POSE_CROP_W, _POSE_CROP_H), flags=cv2.INTER_LINEAR)
    rgb = cv2.cvtColor(warped, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    normed = (rgb - _POSE_MEAN) / _POSE_STD
    return normed.transpose(2, 0, 1), (cx, cy, bw, bh)


def _decode_heatmap_keypoint(
    heatmap: np.ndarray,
    crop_meta: tuple[float, float, float, float],
    frame_w: int,
    frame_h: int,
) -> tuple[float, float, float]:
    """Decodes one keypoint from a `(H, W)` ViTPose heatmap with quarter-pixel peak refinement."""
    hm_h, hm_w = heatmap.shape
    flat_idx = int(np.argmax(heatmap))
    py, px = divmod(flat_idx, hm_w)
    conf = float(heatmap[py, px])
    fx = float(px)
    fy = float(py)
    if 1 <= px < hm_w - 1:
        diff_x = float(heatmap[py, px + 1] - heatmap[py, px - 1])
        if diff_x != 0.0:
            fx += 0.25 if diff_x > 0.0 else -0.25
    if 1 <= py < hm_h - 1:
        diff_y = float(heatmap[py + 1, px] - heatmap[py - 1, px])
        if diff_y != 0.0:
            fy += 0.25 if diff_y > 0.0 else -0.25

    cx, cy, bw, bh = crop_meta
    img_x = (cx - 0.5 * bw + ((fx + 0.5) / hm_w) * bw) / max(1, frame_w)
    img_y = (cy - 0.5 * bh + ((fy + 0.5) / hm_h) * bh) / max(1, frame_h)
    return _clamp01(img_x), _clamp01(img_y), conf


def _fuse_vitpose_coco_expert(model: Any) -> bool:
    """Fuses ViTPose+ MoE MLP blocks to COCO expert 0 (bit-identical output, faster on MPS/CUDA).

    Returns whether `dataset_index` is still required by the backbone.
    """
    import torch
    from torch import nn
    from transformers.models.vitpose_backbone.modeling_vitpose_backbone import VitPoseBackboneMoeMLP

    backbone_cfg = getattr(model.config, "backbone_config", None)
    num_experts = getattr(backbone_cfg, "num_experts", 1) if backbone_cfg is not None else 1
    if num_experts <= 1:
        return False

    class _SingleExpertMLP(nn.Module):
        def __init__(self, moe: VitPoseBackboneMoeMLP, expert_idx: int = 0) -> None:
            super().__init__()
            self.fc1 = moe.fc1
            self.act = moe.act
            expert = moe.experts[expert_idx]
            if not isinstance(expert, nn.Linear):
                raise TypeError(f"Expected Linear expert, got {type(expert)!r}")
            weight = torch.cat([moe.fc2.weight.detach(), expert.weight.detach()], dim=0)
            self.fc2 = nn.Linear(weight.shape[1], weight.shape[0], bias=True)
            with torch.no_grad():
                self.fc2.weight.copy_(weight)
                if moe.fc2.bias is not None and expert.bias is not None:
                    bias = torch.cat([moe.fc2.bias.detach(), expert.bias.detach()], dim=0)
                    self.fc2.bias.copy_(bias)

        def forward(  # ty: ignore[invalid-mutable-override]
            self, hidden_state: torch.Tensor, indices: torch.Tensor | None = None
        ) -> torch.Tensor:
            return self.fc2(self.act(self.fc1(hidden_state)))

    for layer in model.backbone.encoder.layer:
        if isinstance(layer.mlp, VitPoseBackboneMoeMLP):
            layer.mlp = _SingleExpertMLP(layer.mlp, 0)
    return True


class TorchVisionBackend:
    """Two-stage Apache-2.0 PyTorch person detector (D-FINE) + ankle pose estimator (ViTPose)."""

    def __init__(
        self,
        *,
        device: DevicePreference = "auto",
        detector_model: str = DEFAULT_DETECTOR_MODEL_ID,
        pose_model: str = DEFAULT_POSE_MODEL_ID,
        model_cache_dir: Path | None = None,
        score_threshold: float = MIN_DETECTION_SCORE,
        pose_batch_size: int = 32,
    ) -> None:
        self.device = select_device(device)
        self.detector_model = detector_model
        self.pose_model = pose_model
        self._cache_dir = default_model_cache_dir() if model_cache_dir is None else model_cache_dir
        self._score_threshold = score_threshold
        self._pose_batch_size = max(1, pose_batch_size)
        self._det_processor: Any = None
        self._det_model: Any = None
        self._pose_model: Any = None
        self._person_label_ids: frozenset[int] = frozenset()
        self._pose_needs_dataset_index = False
        self._dtype: Any = None

    def _ensure_loaded(self) -> None:
        if self._det_model is not None and self._pose_model is not None:
            return
        import torch
        from transformers import (
            AutoImageProcessor,
            AutoModelForObjectDetection,
            VitPoseForPoseEstimation,
        )

        self._cache_dir.mkdir(parents=True, exist_ok=True)
        torch_device = torch.device(self.device.value)
        dtype = torch.float16 if self.device in (DeviceKind.CUDA, DeviceKind.MPS) else torch.float32
        self._dtype = dtype

        cache_str = str(self._cache_dir)
        self._det_processor = AutoImageProcessor.from_pretrained(
            self.detector_model, cache_dir=cache_str
        )
        det_model = AutoModelForObjectDetection.from_pretrained(
            self.detector_model, cache_dir=cache_str
        )
        det_model.to(device=torch_device, dtype=dtype).eval()
        id2label = getattr(det_model.config, "id2label", {})
        self._person_label_ids = frozenset(
            int(idx) for idx, name in id2label.items() if str(name).lower() == "person"
        )
        if not self._person_label_ids:
            self._person_label_ids = frozenset({0})
        self._det_model = det_model

        pose_model = VitPoseForPoseEstimation.from_pretrained(self.pose_model, cache_dir=cache_str)
        self._pose_needs_dataset_index = _fuse_vitpose_coco_expert(pose_model)
        pose_model.to(device=torch_device, dtype=dtype).eval()
        self._pose_model = pose_model

    def detect_batch(self, frames_bgr: Sequence[np.ndarray]) -> list[tuple[RawDetection, ...]]:
        """Runs D-FINE person detection, batched ViTPose ankle estimation, and HSV appearance."""
        if not frames_bgr:
            return []
        self._ensure_loaded()
        import torch

        torch_device = torch.device(self.device.value)
        dtype = self._dtype
        n_frames = len(frames_bgr)

        # Stage 1: fast OpenCV resize -> [0, 1] float RGB tensor for D-FINE/RT-DETR.
        resized = np.empty(
            (n_frames, _DETECTOR_INPUT_SIZE, _DETECTOR_INPUT_SIZE, 3), dtype=np.uint8
        )
        shapes: list[tuple[int, int]] = []
        for idx, bgr in enumerate(frames_bgr):
            h, w = bgr.shape[:2]
            shapes.append((h, w))
            small = cv2.resize(
                bgr, (_DETECTOR_INPUT_SIZE, _DETECTOR_INPUT_SIZE), interpolation=cv2.INTER_LINEAR
            )
            cv2.cvtColor(small, cv2.COLOR_BGR2RGB, dst=resized[idx])

        pixel_values = (
            torch.from_numpy(resized)
            .permute(0, 3, 1, 2)
            .contiguous()
            .to(device=torch_device, dtype=dtype)
            .div_(255.0)
        )

        with torch.inference_mode():
            det_out = self._det_model(pixel_values=pixel_values)
            det_out.logits = det_out.logits.float().cpu()
            det_out.pred_boxes = det_out.pred_boxes.float().cpu()
            target_sizes = torch.tensor(shapes, dtype=torch.int64)
            processed = self._det_processor.post_process_object_detection(
                det_out, threshold=self._score_threshold, target_sizes=target_sizes
            )

        frame_boxes: list[list[tuple[float, float, float, float, float]]] = []
        pose_crops: list[np.ndarray] = []
        pose_metas: list[tuple[int, int, tuple[float, float, float, float]]] = []

        for frame_idx, (res, (h, w)) in enumerate(zip(processed, shapes, strict=True)):
            inv_w = 1.0 / max(1, w)
            inv_h = 1.0 / max(1, h)
            raw_boxes: list[tuple[float, float, float, float, float]] = []
            for score_t, label_t, box_t in zip(
                res["scores"], res["labels"], res["boxes"], strict=True
            ):
                if int(label_t) not in self._person_label_ids:
                    continue
                bx1, by1, bx2, by2 = box_t.tolist()
                nx1 = _clamp01(bx1 * inv_w)
                ny1 = _clamp01(by1 * inv_h)
                nx2 = _clamp01(bx2 * inv_w)
                ny2 = _clamp01(by2 * inv_h)
                if nx2 <= nx1 or ny2 <= ny1:
                    continue
                raw_boxes.append((nx1, ny1, nx2, ny2, float(score_t)))

            kept = _suppress_duplicates(raw_boxes)
            frame_boxes.append(kept)

            # Stage 2 candidate selection: keep the highest-confidence tall-enough person boxes.
            candidates = [
                det_idx
                for det_idx, box in enumerate(kept)
                if (box[3] - box[1]) >= MIN_POSE_CANDIDATE_HEIGHT
            ][:MAX_POSE_CANDIDATES_PER_FRAME]
            bgr = frames_bgr[frame_idx]
            for det_idx in candidates:
                bx1, by1, bx2, by2, _ = kept[det_idx]
                crop, meta = _extract_pose_crop(bgr, bx1, by1, bx2, by2)
                pose_crops.append(crop)
                pose_metas.append((frame_idx, det_idx, meta))

        # Stage 2: batched ViTPose ankle estimation across all crops in the frame batch.
        ankles_by_det: dict[
            tuple[int, int], tuple[tuple[float, float, float], tuple[float, float, float]]
        ] = {}
        if pose_crops:
            with torch.inference_mode():
                for start in range(0, len(pose_crops), self._pose_batch_size):
                    chunk = np.stack(pose_crops[start : start + self._pose_batch_size])
                    crop_tensor = torch.from_numpy(chunk).to(device=torch_device, dtype=dtype)
                    kwargs: dict[str, Any] = {}
                    if self._pose_needs_dataset_index:
                        kwargs["dataset_index"] = torch.zeros(
                            len(chunk), dtype=torch.long, device=torch_device
                        )
                    pose_out = self._pose_model(pixel_values=crop_tensor, **kwargs)
                    heatmaps = pose_out.heatmaps.float().cpu().numpy()
                    for offset in range(heatmaps.shape[0]):
                        frame_idx, det_idx, meta = pose_metas[start + offset]
                        h, w = shapes[frame_idx]
                        left = _decode_heatmap_keypoint(
                            heatmaps[offset, _COCO_LEFT_ANKLE], meta, w, h
                        )
                        right = _decode_heatmap_keypoint(
                            heatmaps[offset, _COCO_RIGHT_ANKLE], meta, w, h
                        )
                        ankles_by_det[(frame_idx, det_idx)] = (left, right)

        results: list[tuple[RawDetection, ...]] = []
        for frame_idx, (bgr, boxes) in enumerate(zip(frames_bgr, frame_boxes, strict=True)):
            frame_dets: list[RawDetection] = []
            for det_idx, (x1, y1, x2, y2, score) in enumerate(boxes):
                pair = ankles_by_det.get((frame_idx, det_idx))
                left_ankle = None if pair is None else pair[0]
                right_ankle = None if pair is None else pair[1]
                emb = extract_appearance_embedding(bgr, x1, y1, x2, y2)
                frame_dets.append(
                    RawDetection(
                        x1=x1,
                        y1=y1,
                        x2=x2,
                        y2=y2,
                        score=score,
                        left_ankle=left_ankle,
                        right_ankle=right_ankle,
                        appearance=emb,
                    )
                )
            results.append(tuple(frame_dets))
        return results
