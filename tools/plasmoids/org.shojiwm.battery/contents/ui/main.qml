/*
 * The taskbar's battery: the level as a number inside a small battery.
 *
 *   level >= 50  green     20..49  yellow     below 20  red
 *
 * The colours are the traffic lights' (red #ff5f57, yellow #febc2e, green
 * #28c840). It reads /sys/class/power_supply/BAT* every 20 s. On a machine
 * with no battery (a desktop PC) it hides itself. A click opens KDE's power
 * settings. Install: copy this folder to ~/.local/share/plasma/plasmoids/.
 */
import QtQuick
import QtQuick.Layouts
import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.plasma5support as P5Support

PlasmoidItem {
    id: root

    // Change these two numbers to move the colour steps.
    readonly property int greenFrom: 50
    readonly property int redBelow: 20

    property int level: -1              // -1: no battery
    property string batteryState: ""    // Charging, Discharging, Full, ...
    readonly property color levelColor: level >= greenFrom ? "#28c840"
                                      : level >= redBelow ? "#febc2e" : "#ff5f57"

    preferredRepresentation: fullRepresentation
    Plasmoid.status: level < 0 ? PlasmaCore.Types.HiddenStatus : PlasmaCore.Types.ActiveStatus
    toolTipMainText: "Battery " + level + "%"
    toolTipSubText: batteryState === "Discharging" ? "On battery"
                  : batteryState === "Not charging" ? "Plugged in, not charging"
                  : batteryState

    // One read every 20 s: the level on the first line, the state on the second.
    P5Support.DataSource {
        id: reader
        engine: "executable"
        interval: 20000
        connectedSources: ["sh -c 'b=$(ls -d /sys/class/power_supply/BAT* 2>/dev/null | head -n 1); [ -n \"$b\" ] && cat \"$b/capacity\" \"$b/status\"'"]
        onNewData: function(source, data) {
            const lines = String(data["stdout"] || "").trim().split("\n");
            const value = parseInt(lines[0]);
            root.level = isNaN(value) ? -1 : Math.max(0, Math.min(100, value));
            root.batteryState = lines.length > 1 ? lines[1].trim() : "";
        }
    }
    P5Support.DataSource {
        id: launcher
        engine: "executable"
        onNewData: function(source) { disconnectSource(source) }
    }

    fullRepresentation: Item {
        id: cell
        readonly property real bodyH: Math.round(Math.min(height * 0.62, 20))
        readonly property real bodyW: Math.round(bodyH * 2.05)
        Layout.minimumWidth: root.level < 0 ? 0 : bodyW + 10
        Layout.preferredWidth: Layout.minimumWidth
        Layout.maximumWidth: Layout.minimumWidth
        visible: root.level >= 0

        Item {
            anchors.centerIn: parent
            width: cell.bodyW + 3
            height: cell.bodyH

            // The body: a light rim, a dark inside, the level as a coloured fill.
            Rectangle {
                id: body
                width: cell.bodyW
                height: parent.height
                radius: Math.round(height * 0.28)
                color: "#40000000"
                border.width: 1.5
                border.color: "#e6ebf2"

                Rectangle {
                    x: 2.5
                    y: 2.5
                    height: parent.height - 5
                    width: Math.max(height * 0.35, (parent.width - 5) * root.level / 100)
                    radius: Math.max(1, body.radius - 2)
                    color: root.levelColor
                }
            }
            // The nub on the right.
            Rectangle {
                anchors.verticalCenter: body.verticalCenter
                x: body.width + 0.5
                width: 2.5
                height: Math.round(body.height * 0.42)
                radius: 1
                color: "#e6ebf2"
            }
            // The number: white, with the glyphs' soft dark edge just below it.
            Text {
                anchors.centerIn: body
                anchors.verticalCenterOffset: 1
                text: label.text
                font: label.font
                color: "#8c000000"
            }
            Text {
                id: label
                anchors.centerIn: body
                text: root.level
                color: "#ffffff"
                font.family: "Noto Sans"
                font.bold: true
                font.pixelSize: Math.round(cell.bodyH * 0.62)
                renderType: Text.CurveRendering
            }
        }

        MouseArea {
            anchors.fill: parent
            onClicked: launcher.connectSource("systemsettings kcm_powerdevilprofilesconfig")
        }
    }
}
