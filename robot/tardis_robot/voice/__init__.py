"""Spark's voice. The robot is one more client of the ship's Grok realtime
voice socket (``/ws/voice``): it streams its microphone up, plays the agent's
reply on its speaker, and follows the call state so the eyes and lights match
what is happening. See :mod:`tardis_robot.voice.grok`."""
