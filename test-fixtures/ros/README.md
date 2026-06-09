# ROS test fixtures

Real, publicly-sourced ROS log files used by the ROS1/ROS2 readers' unit
tests and the visual-verification pass. All are small enough to commit; larger
real bags (e.g. the 67 MB foxglove `demo.bag`, or the full turtlesim
conversions) are fetched on demand by `scripts/fetch-ros-fixtures.sh` rather
than committed, mirroring the comma2k19 verify pattern.

| File | Format | Source | Notes |
| --- | --- | --- | --- |
| `turtle.bag` | ROS1 `.bag` (v2.0, uncompressed) | [cruise-automation/webviz](https://github.com/cruise-automation/webviz) `fixtures/example.bag` | Real recorded turtlesim session, 21.7 s. Topics: `turtlesim/Pose`, `geometry_msgs/Twist`, `turtlesim/Color`, `tf2_msgs/TFMessage`. Self-describing (connection records embed `message_definition`). |
| `ros2_cdr_test.mcap` | ROS2 MCAP (CDR, `ros2msg`) | [ros2/rosbag2](https://github.com/ros2/rosbag2) `resources/mcap/cdr_test` | Upstream rosbag2 test bag. `test_msgs/{BasicTypes,Arrays}`. Schema records embed the definition text, so the dynamic decoder reads it without an external typestore. |
| `synth_imu.mcap` | ROS2 MCAP (CDR) | synthesized with `rosbags` | `sensor_msgs/Imu` @ 100 Hz + `std_msgs/Float64`. Richer numeric signals for plotting. |
| `ros2_cdr_test.db3` | ROS2 rosbag2 SQLite | [ros2/rosbag2](https://github.com/ros2/rosbag2) `resources/sqlite3/cdr_test` | Upstream test bag. `.db3` is NOT self-describing (no embedded definitions); decoded via the bundled standard-message typestore. |
| `synth_imu.db3` | ROS2 rosbag2 SQLite | synthesized with `rosbags` | `sensor_msgs/Imu` + `std_msgs/Float64`; decodes against the standard typestore. |

The `.db3` files are read directly from their `topics`/`messages` tables (the
`metadata.yaml` sidecar is not required at read time).
