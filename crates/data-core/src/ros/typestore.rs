//! Bundled "typestore" of standard ROS message definitions.
//!
//! ROS2 SQLite (`.db3`) bags are **not** self-describing: unlike MCAP, they do
//! not embed the message-definition text alongside the data, so to CDR-decode
//! their messages we must supply the definition for every standard message type
//! from a built-in table. This module is that table.
//!
//! Each entry is the full *concatenated* message-definition text (root fields,
//! then each dependent type after an 80-`=` separator and a `MSG: pkg/Type`
//! header), exactly the format consumed by
//! [`crate::ros::MessageRegistry::parse`].
//!
//! The bulk of these definitions were generated from the `rosbags` Python
//! library's ROS2 Humble typestore (`typestore.generate_msgdef(name,
//! ros_version=2)`), which emits this concatenated form verbatim. The handful
//! of types that library does not ship (`rosgraph_msgs/Log` and the two
//! `turtlesim` types) were authored by hand to the same convention. The text
//! lives in sibling `.msg` files under `ros/typedefs/` and is embedded via
//! [`include_str!`].
//!
//! Pure and portable: no filesystem access at runtime, no browser deps — safe
//! for `wasm32-unknown-unknown`.

/// Return the full concatenated ROS message-definition text for a standard ROS
/// type name, suitable for [`crate::ros::MessageRegistry::parse`].
///
/// Both naming styles are accepted and normalised internally:
/// - ROS2 `pkg/msg/Type` (the middle `msg`/`srv` segment is stripped), and
/// - ROS1 `pkg/Type`.
///
/// The returned text always includes the root type's fields followed by every
/// dependent type (`Header`, `Vector3`, `Quaternion`, …) in the
/// `================` + `MSG: pkg/Type` concatenation convention, so the parser
/// can resolve nested fields.
///
/// Returns `None` for any type not in the bundled set.
pub fn lookup(type_name: &str) -> Option<&'static str> {
    Some(match normalize(type_name).as_str() {
        // builtin_interfaces
        "builtin_interfaces/Time" => include_str!("typedefs/builtin_interfaces__Time.msg"),
        "builtin_interfaces/Duration" => {
            include_str!("typedefs/builtin_interfaces__Duration.msg")
        }
        // std_msgs
        "std_msgs/Header" => include_str!("typedefs/std_msgs__Header.msg"),
        "std_msgs/Float64" => include_str!("typedefs/std_msgs__Float64.msg"),
        "std_msgs/Float32" => include_str!("typedefs/std_msgs__Float32.msg"),
        "std_msgs/Int32" => include_str!("typedefs/std_msgs__Int32.msg"),
        "std_msgs/Int64" => include_str!("typedefs/std_msgs__Int64.msg"),
        "std_msgs/UInt32" => include_str!("typedefs/std_msgs__UInt32.msg"),
        "std_msgs/Bool" => include_str!("typedefs/std_msgs__Bool.msg"),
        "std_msgs/String" => include_str!("typedefs/std_msgs__String.msg"),
        // geometry_msgs
        "geometry_msgs/Vector3" => include_str!("typedefs/geometry_msgs__Vector3.msg"),
        "geometry_msgs/Point" => include_str!("typedefs/geometry_msgs__Point.msg"),
        "geometry_msgs/Quaternion" => include_str!("typedefs/geometry_msgs__Quaternion.msg"),
        "geometry_msgs/Twist" => include_str!("typedefs/geometry_msgs__Twist.msg"),
        "geometry_msgs/TwistStamped" => {
            include_str!("typedefs/geometry_msgs__TwistStamped.msg")
        }
        "geometry_msgs/Pose" => include_str!("typedefs/geometry_msgs__Pose.msg"),
        "geometry_msgs/PoseStamped" => include_str!("typedefs/geometry_msgs__PoseStamped.msg"),
        "geometry_msgs/Transform" => include_str!("typedefs/geometry_msgs__Transform.msg"),
        "geometry_msgs/TransformStamped" => {
            include_str!("typedefs/geometry_msgs__TransformStamped.msg")
        }
        "geometry_msgs/Accel" => include_str!("typedefs/geometry_msgs__Accel.msg"),
        // sensor_msgs
        "sensor_msgs/Imu" => include_str!("typedefs/sensor_msgs__Imu.msg"),
        "sensor_msgs/Temperature" => include_str!("typedefs/sensor_msgs__Temperature.msg"),
        "sensor_msgs/MagneticField" => include_str!("typedefs/sensor_msgs__MagneticField.msg"),
        "sensor_msgs/FluidPressure" => include_str!("typedefs/sensor_msgs__FluidPressure.msg"),
        "sensor_msgs/NavSatFix" => include_str!("typedefs/sensor_msgs__NavSatFix.msg"),
        // nav_msgs
        "nav_msgs/Odometry" => include_str!("typedefs/nav_msgs__Odometry.msg"),
        // tf2_msgs
        "tf2_msgs/TFMessage" => include_str!("typedefs/tf2_msgs__TFMessage.msg"),
        // rosgraph_msgs
        "rosgraph_msgs/Log" => include_str!("typedefs/rosgraph_msgs__Log.msg"),
        // turtlesim
        "turtlesim/Pose" => include_str!("typedefs/turtlesim__Pose.msg"),
        "turtlesim/Color" => include_str!("typedefs/turtlesim__Color.msg"),
        _ => return None,
    })
}

/// Normalise a type name to the canonical `pkg/Type` key by stripping a middle
/// interface-kind segment (`msg`/`srv`) from a ROS2 `pkg/msg/Type` name. ROS1
/// `pkg/Type` names pass through unchanged.
fn normalize(type_name: &str) -> String {
    let raw = type_name.trim();
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() == 3 && matches!(parts[1], "msg" | "srv") {
        format!("{}/{}", parts[0], parts[2])
    } else {
        raw.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ros::{numeric_leaves, MessageRegistry};

    /// Every type bundled by this module, as the canonical `pkg/Type` key.
    const BUNDLED: &[&str] = &[
        "builtin_interfaces/Time",
        "builtin_interfaces/Duration",
        "std_msgs/Header",
        "std_msgs/Float64",
        "std_msgs/Float32",
        "std_msgs/Int32",
        "std_msgs/Int64",
        "std_msgs/UInt32",
        "std_msgs/Bool",
        "std_msgs/String",
        "geometry_msgs/Vector3",
        "geometry_msgs/Point",
        "geometry_msgs/Quaternion",
        "geometry_msgs/Twist",
        "geometry_msgs/TwistStamped",
        "geometry_msgs/Pose",
        "geometry_msgs/PoseStamped",
        "geometry_msgs/Transform",
        "geometry_msgs/TransformStamped",
        "geometry_msgs/Accel",
        "sensor_msgs/Imu",
        "sensor_msgs/Temperature",
        "sensor_msgs/MagneticField",
        "sensor_msgs/FluidPressure",
        "sensor_msgs/NavSatFix",
        "nav_msgs/Odometry",
        "tf2_msgs/TFMessage",
        "rosgraph_msgs/Log",
        "turtlesim/Pose",
        "turtlesim/Color",
    ];

    /// Insert a `msg` interface-kind segment so `pkg/Type` becomes the ROS2
    /// `pkg/msg/Type` spelling.
    fn ros2_spelling(short: &str) -> String {
        let (pkg, ty) = short.split_once('/').unwrap();
        format!("{pkg}/msg/{ty}")
    }

    #[test]
    fn lookup_resolves_both_spellings_for_every_bundled_type() {
        for &short in BUNDLED {
            let via_ros1 = lookup(short);
            assert!(via_ros1.is_some(), "missing ROS1 spelling for {short}");

            let ros2 = ros2_spelling(short);
            let via_ros2 = lookup(&ros2);
            assert!(via_ros2.is_some(), "missing ROS2 spelling for {ros2}");

            // Both spellings must resolve to the identical text.
            assert_eq!(via_ros1, via_ros2, "spellings disagree for {short}");
        }
    }

    #[test]
    fn lookup_returns_none_for_unknown_types() {
        assert!(lookup("not_a_pkg/NoSuchType").is_none());
        assert!(lookup("not_a_pkg/msg/NoSuchType").is_none());
        assert!(lookup("").is_none());
        assert!(lookup("sensor_msgs/Imu/Extra/Junk").is_none());
    }

    #[test]
    fn every_bundled_definition_parses() {
        for &short in BUNDLED {
            let text = lookup(short).unwrap();
            MessageRegistry::parse(short, text)
                .unwrap_or_else(|e| panic!("failed to parse {short}: {e:?}"));
        }
    }

    /// Collect the dot-separated leaf paths surfaced for a parsed type.
    fn leaf_paths(name: &str) -> Vec<String> {
        let text = lookup(name).unwrap();
        let reg = MessageRegistry::parse(name, text).unwrap();
        numeric_leaves(&reg).into_iter().map(|l| l.path).collect()
    }

    #[test]
    fn imu_yields_expected_leaves() {
        let paths = leaf_paths("sensor_msgs/msg/Imu");
        for expected in [
            "orientation.x",
            "orientation.w",
            "angular_velocity.z",
            "linear_acceleration.x",
        ] {
            assert!(
                paths.iter().any(|p| p == expected),
                "Imu missing leaf {expected}; got {paths:?}"
            );
        }
        // The header timestamp is reachable through the injected builtins.
        assert!(paths.iter().any(|p| p == "header.stamp.sec"));
    }

    #[test]
    fn twist_yields_expected_leaves() {
        let paths = leaf_paths("geometry_msgs/msg/Twist");
        for expected in ["linear.x", "linear.y", "linear.z", "angular.z"] {
            assert!(
                paths.iter().any(|p| p == expected),
                "Twist missing leaf {expected}; got {paths:?}"
            );
        }
    }

    #[test]
    fn turtlesim_pose_yields_expected_leaves() {
        // turtlesim/Pose is hand-written; verify it parses and exposes the
        // expected flat float32 fields under both spellings.
        let paths = leaf_paths("turtlesim/Pose");
        for expected in ["x", "y", "theta", "linear_velocity", "angular_velocity"] {
            assert!(
                paths.iter().any(|p| p == expected),
                "turtlesim/Pose missing leaf {expected}; got {paths:?}"
            );
        }
    }
}
