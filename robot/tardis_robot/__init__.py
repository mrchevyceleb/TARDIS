"""TARDIS robot companion.

A small always-on process that runs on a desk robot (the Doly, or anything that
implements ``hardware.base.Hardware``) and dials into a TARDIS server over the
``/ws/device`` link as ``kind: robot``. Companions then reach the body through
the ``robot_*`` tools, and the robot reports what it notices as events. Voice
rides on the existing Jarvis LiveKit worker: the robot is just another caller
with a wake word, microphones and a speaker.
"""

__version__ = "0.1.0"
PROTOCOL_VERSION = "robot-1"
