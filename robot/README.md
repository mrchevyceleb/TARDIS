# TARDIS robot companion

Runs on a desk robot and links it to a TARDIS server as a body for the
companions. Reference hardware is the [Doly](https://github.com/robotdoly/DOLY-DIY);
a mock body is included for development.

```bash
sudo ./install.sh https://your-server.your-tailnet.ts.net Spark   # on the robot
tardis-robot --hardware mock --url http://127.0.0.1:8091          # anywhere
```

Full guide: [docs/ROBOT.md](../docs/ROBOT.md).

```text
tardis_robot/
  link.py          /ws/device client (hello, requests, events, reconnect)
  ops.py           robot.* handlers, motion lock, cancel
  behaviors.py     local reflexes and event forwarding
  hardware/        base interface, doly (SDK), mock
  voice/           Jarvis call over LiveKit, local audio, wake word
  app.py           wiring; __main__.py CLI
tests/             link + ops against a fake ship on the mock body
install.sh, tardis-robot.service
```
