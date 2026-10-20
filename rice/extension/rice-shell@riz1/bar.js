// The top bar as three floating islands that line up with the desktop widgets
// (from rice-bar). Left: workspaces and the focused app. Right: the status icons.
// Centre: a capsule in the clock's place that shows, in order of priority, a
// notification for a few seconds, a meeting about to start, the music that's
// playing, or the date and time. Clicking it still opens GNOME's calendar menu.
// A notification widens the capsule to fit; one that still won't fit, or that has
// buttons, drops below it as a card. Pointing at either holds the notification.
//
// Layout is in stylesheet.css; colours come from the theme (rice-bar.css, which
// rice appends to the shell stylesheet of every theme).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const MEETING_LEAD_MS = 10 * 60 * 1000;   // show a meeting this long before it starts
const MEETING_GRACE_MS = 5 * 60 * 1000;   // and until this long after
// How long a notification stays: 4 s, plus 1 s per 15 characters to read, up to 12 s.
const FLASH_MIN_MS = 4000;
const FLASH_MAX_MS = 12000;
const FLASH_CHARS_PER_S = 15;
const FLASH_RESUME_MS = 1500;              // at least this long left once the pointer leaves
const HOVER_LEAVE_MS = 200;                // time to cross the gap between capsule and card
const PILL_SHARE = 0.5;                    // a notification widens the capsule up to half the
const PILL_MAX = 900;                      // monitor and this many px,
const PILL_TITLE_MAX = 360;                // the title taking at most this much of it
const PILL_CHROME = 80;                    // the capsule's padding, badge and spacing
const CARD_BODY_CHARS = 180;               // about three lines of the card
const CARD_GAP = 8;                        // between the capsule and the card
const FADE_MS = 140;

const FocusedApp = GObject.registerClass(
class FocusedApp extends PanelMenu.Button {
    _init() {
        super._init(0, 'Focused app', true);
        this.add_style_class_name('rice-app');
        this.setSensitive(false);

        const box = new St.BoxLayout({style_class: 'rice-app-box'});
        box.add_child(new St.Widget({style_class: 'rice-sep', y_align: Clutter.ActorAlign.CENTER}));
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._label);
        this.add_child(box);

        this._tracker = Shell.WindowTracker.get_default();
        global.display.connectObject('notify::focus-window', () => this._sync(), this);
        this._tracker.connectObject('notify::focus-app', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const win = global.display.focus_window;
        // The desktop (Gtk4-DING) and its widgets are windows too; they aren't "the app".
        if (!win || win.skip_taskbar || win.get_window_type() !== Meta.WindowType.NORMAL) {
            this.hide();
            return;
        }
        this._label.text = this._tracker.get_window_app(win)?.get_name() ?? win.title ?? '';
        this.visible = this._label.text !== '';
    }
});

// A hairline that drains over a notification's time on screen. A timeline drives it
// rather than ease(): GNOME scales eased durations by the animation speed, and this
// has to match the real time left.
const Countdown = GObject.registerClass(
class Countdown extends St.Widget {
    _init(params) {
        super._init({style_class: 'rice-timer', layout_manager: new Clutter.BinLayout(), ...params});
        this._fill = new St.Widget({style_class: 'rice-timer-fill', x_expand: true, y_expand: true});
        this._fill.set_pivot_point(0, 0.5);
        this.add_child(this._fill);
        this.connect('destroy', () => this.stop());
    }

    // Drains what's left of the line over `ms`.
    run(ms) {
        this.stop();
        const from = this._fill.scale_x;
        this._timeline = new Clutter.Timeline({actor: this._fill, duration: Math.max(1, Math.round(ms))});
        this._timeline.connect('new-frame', t => {
            this._fill.scale_x = from * (1 - t.get_progress());
        });
        this._timeline.start();
    }

    stop() {
        this._timeline?.stop();
        this._timeline = null;
    }

    reset() {
        this.stop();
        this._fill.scale_x = 1;
    }
});

// The capsule's contents: an optional badge, then lead · main · trail labels, and a
// countdown under them while a notification shows.
const Capsule = GObject.registerClass(
class Capsule extends St.Widget {
    _init() {
        super._init({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});

        const row = new St.BoxLayout({style_class: 'rice-capsule-box'});
        this._badge = new St.Bin({style_class: 'rice-badge', y_align: Clutter.ActorAlign.CENTER});
        this._badgeIcon = new St.Icon({style_class: 'rice-badge-icon'});
        this._badge.set_child(this._badgeIcon);
        this._lead = this._label('rice-lead');
        this._main = this._label('rice-main');
        this._trail = this._label('rice-trail');
        row.add_child(this._badge);
        row.add_child(this._lead);
        row.add_child(this._main);
        row.add_child(this._trail);
        this.add_child(row);
        // Below the row (out of its layout), near the capsule's bottom edge.
        this.countdown = new Countdown({
            x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.END, translation_y: 4, visible: false,
        });
        this.add_child(this.countdown);
        this._key = null;
    }

    // The widths a notification's title and body need, if together they fit in `max`
    // px (null if not). Both are measured in the body label's font: the title label may
    // still be in the idle clock's monospace one.
    fit(main, trail, max) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = (text, weight) => {
            if (!text)
                return 0;
            const font = this._trail.get_theme_node().get_font().copy();
            font.set_weight(weight);
            const layout = this._trail.clutter_text.create_pango_layout(text);
            layout.set_font_description(font);
            return Math.ceil(layout.get_pixel_extents()[1].width / scale) + 2;
        };
        const mainWidth = width(main, Pango.Weight.SEMIBOLD);
        const trailWidth = width(trail, Pango.Weight.MEDIUM);
        if (mainWidth > PILL_TITLE_MAX || mainWidth + trailWidth > max - PILL_CHROME)
            return null;
        return {main: mainWidth, trail: trailWidth};
    }

    _label(styleClass) {
        const label = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return label;
    }

    // state: {kind, lead, main, trail, gicon, image, widths, countdown}; `widths` (from
    // fit()) lifts the labels' usual limits. A new kind, or a new title within one,
    // fades the old content out and the new in; the ticking clock updates in place.
    show(state) {
        const key = state.kind === 'idle' ? 'idle' : `${state.kind}\n${state.main}`;
        if (this._key === null || key === this._key) {
            this._key = key;
            this._apply(state);
            return;
        }
        this._key = key;
        this._pending = state;
        if (this._fading)
            return;
        this._fading = true;
        this.ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._fading = false;
                this._apply(this._pending);
                this.ease({opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD});
            },
        });
    }

    _apply({kind, lead = '', main = '', trail = '', gicon = null, image = null, widths = null, countdown = false}) {
        for (const k of ['idle', 'media', 'meeting', 'flash'])
            this[k === kind ? 'add_style_class_name' : 'remove_style_class_name'](`rice-${k}`);

        this._badge.visible = Boolean(gicon || image);
        this._badge.style = image ? `background-image: url("${image}");` : null;
        this._badgeIcon.visible = !image;
        this._badgeIcon.gicon = image ? null : gicon;

        for (const [label, text] of [[this._lead, lead], [this._main, main], [this._trail, trail]]) {
            label.text = text;
            label.visible = text !== '';
        }
        this._main.style = widths ? `max-width: ${widths.main}px;` : null;
        this._trail.style = widths ? `max-width: ${widths.trail}px;` : null;
        this.countdown.visible = countdown;
    }
});

// A notification that won't fit the capsule, or has buttons, drops below it as this
// card. Clicking the text opens the notification, the buttons are its actions, and ×
// only closes the card (the notification stays in the calendar menu's list).
const NotificationCard = GObject.registerClass(
class NotificationCard extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'rice-card', orientation: Clutter.Orientation.VERTICAL,
            reactive: true, track_hover: true, visible: false,
        });

        const head = new St.BoxLayout({style_class: 'rice-card-head'});
        this._icon = new St.Icon({style_class: 'rice-card-icon', y_align: Clutter.ActorAlign.CENTER});
        this._app = new St.Label({style_class: 'rice-card-app', y_align: Clutter.ActorAlign.CENTER});
        this._app.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._paused = new St.Label({
            style_class: 'rice-card-paused', text: 'paused', opacity: 0,
            x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
        });
        this.close = new St.Button({
            style_class: 'rice-card-close', y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });
        for (const child of [this._icon, this._app, this._paused, this.close])
            head.add_child(child);

        const text = new St.BoxLayout({style_class: 'rice-card-text', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._title = new St.Label({style_class: 'rice-card-title'});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._body = new St.Label({style_class: 'rice-card-body'});
        this._body.clutter_text.line_wrap = true;
        this._body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._body.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        text.add_child(this._title);
        text.add_child(this._body);
        this.main = new St.Button({style_class: 'rice-card-main', child: text, x_expand: true});

        this._actions = new St.BoxLayout({style_class: 'rice-card-actions'});
        this.countdown = new Countdown({x_expand: true});
        for (const child of [head, this.main, this._actions, this.countdown])
            this.add_child(child);
    }

    // {app, title, body, gicon, actions}; onAction(action) runs a button.
    fill({app, title, body, gicon, actions}, onAction) {
        this._icon.gicon = gicon;
        this._app.text = app;
        this._title.text = title;
        this._title.visible = title !== '';
        this._body.text = body;
        this._body.visible = body !== '';
        this._actions.destroy_all_children();
        actions.slice(0, 3).forEach((action, i) => {
            const button = new St.Button({style_class: 'rice-card-action', label: action.label});
            if (i === 0)
                button.add_style_class_name('rice-card-primary');
            button.connect('clicked', () => onAction(action));
            this._actions.add_child(button);
        });
        this._actions.visible = actions.length > 0;
        this.setPaused(false);
        this.countdown.reset();
    }

    setPaused(paused) {
        this._paused.opacity = paused ? 255 : 0;
    }

    clearActions() {
        this._actions.destroy_all_children();
        this._actions.hide();
    }
});

// The first `max` characters of `text`, cut at a word.
function clip(text, max) {
    if (text.length <= max)
        return text;
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export class RiceBar {
    constructor(path) {
        this._path = path;
    }

    enable() {
        // Everything _sync() reads, before anything that can call it.
        this._events = [];
        this._flash = null;
        this._players = new Set();
        this._sources = new Set();

        this._panel = Main.panel;
        this._dateMenu = this._panel.statusArea.dateMenu;

        Main.layoutManager.panelBox.add_style_class_name('rice-bar-box');
        this._panel.add_style_class_name('rice-bar');
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interface.connectObject('changed::clock-format', () => this._sync(), this);

        this._app = new FocusedApp();
        this._panel.addToStatusArea('rice-bar-app', this._app, 1, 'left');

        // The capsule takes the clock's place inside the date menu button, so the
        // button, its menu and the unread-notifications dot all keep working.
        this._capsule = new Capsule();
        this._dateMenu.add_style_class_name('rice-capsule');
        this._dateMenu._clockDisplay.hide();
        this._dateMenu._clockDisplay.get_parent().insert_child_above(this._capsule, this._dateMenu._clockDisplay);

        this._card = new NotificationCard();
        Main.layoutManager.addTopChrome(this._card);
        this._card.main.connect('clicked', () => this._activateFlash());
        this._card.close.connect('clicked', () => this._endFlash());
        this._card.connectObject('notify::hover', () => this._syncHover(), this);
        this._dateMenu.connectObject(
            'notify::hover', () => this._syncHover(),
            // The capsule resizes with what it shows; the card stays centred under it.
            'notify::allocation', () => this._queuePlaceCard(),
            this);
        // Opening the calendar (clicking the capsule) shows the notification in its list.
        this._dateMenu.menu.connectObject('open-state-changed', (_, open) => {
            if (open)
                this._endFlash();
        }, this);

        this._clock = new GnomeDesktop.WallClock();
        this._clock.connectObject('notify::clock', () => this._sync(), this);

        this._watchMedia();
        this._watchNotifications();
        this._startCalendarHelper();

        this._sync();
    }

    // Also undoes a partial enable() (one that threw), so every step checks.
    disable() {
        this._stopCalendarHelper();

        this._dropFlash();
        if (this._placeLater)
            global.compositor.get_laters().remove(this._placeLater);
        this._placeLater = 0;
        this._card?.destroy();
        this._card = null;
        this._dateMenu?.disconnectObject(this);
        this._dateMenu?.menu.disconnectObject(this);
        Main.messageTray.disconnectObject(this);
        for (const source of this._sources ?? [])
            source.disconnectObject(this);
        this._sources = null;

        this._media?.disconnectObject(this);
        for (const player of this._players ?? [])
            player.disconnectObject(this);
        this._players = null;
        this._media = null;

        this._clock?.disconnectObject(this);
        this._clock = null;

        this._capsule?.destroy();
        this._capsule = null;
        this._dateMenu?._clockDisplay.show();
        this._dateMenu?.remove_style_class_name('rice-capsule');

        this._app?.destroy();
        this._app = null;

        this._interface?.disconnectObject(this);
        this._interface = null;
        this._panel?.remove_style_class_name('rice-bar');
        Main.layoutManager.panelBox.remove_style_class_name('rice-bar-box');
        this._panel = null;
        this._dateMenu = null;
    }

    // ---- media ------------------------------------------------------------

    _watchMedia() {
        // The calendar menu already watches the players for its media card; share it.
        this._media = this._dateMenu._messageList?._messageView?._mediaSource ?? new Mpris.MprisSource();
        this._players = new Set();
        this._media.connectObject(
            'player-added', (_, player) => this._addPlayer(player),
            'player-removed', (_, player) => {
                player.disconnectObject(this);
                this._players.delete(player);
                this._sync();
            },
            this);
        this._media.players.forEach(player => this._addPlayer(player));
    }

    _addPlayer(player) {
        if (this._players.has(player))
            return;
        this._players.add(player);
        player.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _mediaState() {
        const player = [...this._players].find(p => p.canPlay && p.status === 'Playing');
        if (!player)
            return null;
        const art = player.trackCoverUrl;
        return {
            kind: 'media',
            main: player.trackTitle,
            trail: player.trackArtists?.join(', ') ?? '',
            // Browsers and most players hand over a cached file; anything else gets the app's icon.
            image: art?.startsWith('file://') ? art : null,
            gicon: player.app?.get_icon() ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'}),
        };
    }

    // ---- notifications -----------------------------------------------------

    _watchNotifications() {
        this._sources = new Set();
        Main.messageTray.connectObject(
            'source-added', (_, source) => this._watchSource(source),
            'source-removed', (_, source) => {
                source.disconnectObject(this);
                this._sources.delete(source);
            },
            this);
        Main.messageTray.getSources().forEach(source => this._watchSource(source));
    }

    _watchSource(source) {
        this._sources.add(source);
        source.connectObject('notification-request-banner', (_, notification) => {
            // Same rule as the banners: muted apps and Do Not Disturb only let critical ones through.
            if (!source.policy.showBanners && notification.urgency !== MessageTray.Urgency.CRITICAL)
                return;
            this._showFlash(notification);
        }, this);
    }

    _showFlash(notification) {
        this._dropFlash();
        const strip = text => (text ?? '').replace(/<[^>]*>/g, '').trim();
        const app = notification.source?.title ?? '';
        const title = strip(notification.title) || app;
        const body = strip(notification.body);
        const line = body.split('\n')[0].trim();
        const gicon = notification.gicon ?? notification.source?.icon ??
            new Gio.ThemedIcon({name: 'preferences-system-notifications-symbolic'});
        const actions = notification.actions ?? [];

        // The capsule widens to fit the text; what still won't fit (or has buttons, or
        // more lines) drops into the card, and the capsule only names the app.
        const widths = actions.length === 0 && line === body ? this._capsule.fit(title, line, this._pillWidth()) : null;
        this._flash = {
            notification,
            card: !widths,
            state: widths
                ? {kind: 'flash', main: title, trail: line, gicon, widths, countdown: true}
                : {kind: 'flash', main: app || title, gicon},
        };
        this._card.fill({app: app || title, title, body: clip(body, CARD_BODY_CHARS), gicon, actions}, action => {
            action.activate();
            this._endFlash();
        });
        // Dismissed elsewhere (or activated): done. Closed by its app, as GNOME does when
        // a sender like notify-send exits: the text stays its time, without the buttons.
        notification.connectObject('destroy', (_, reason) => {
            if (reason === MessageTray.NotificationDestroyedReason.DISMISSED) {
                this._endFlash();
                return;
            }
            notification.disconnectObject(this);
            this._flash.notification = null;
            this._card.clearActions();
        }, this);

        this._capsule.countdown.reset();
        const chars = title.length + body.length;
        this._runFlash(Math.min(FLASH_MAX_MS, FLASH_MIN_MS + chars * 1000 / FLASH_CHARS_PER_S));
        if (this._flash.card)
            this._openCard();
        this._sync();
        if (this._dateMenu.hover || this._card.hover)
            this._syncHover();
    }

    _pillWidth() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return Math.min(PILL_MAX, Math.round(Main.layoutManager.primaryMonitor.width / scale * PILL_SHARE));
    }

    // Shows the notification for `ms` more, with the countdowns draining to match.
    _runFlash(ms) {
        if (this._flashTimeout)
            GLib.source_remove(this._flashTimeout);
        this._flash.deadline = GLib.get_monotonic_time() / 1000 + ms;
        this._flashTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(ms), () => {
            this._flashTimeout = 0;
            this._endFlash();
            return GLib.SOURCE_REMOVE;
        });
        this._capsule.countdown.run(ms);
        this._card.countdown.run(ms);
        this._card.setPaused(false);
    }

    _holdFlash() {
        if (!this._flashTimeout)
            return;
        GLib.source_remove(this._flashTimeout);
        this._flashTimeout = 0;
        this._flash.left = Math.max(0, this._flash.deadline - GLib.get_monotonic_time() / 1000);
        this._capsule.countdown.stop();
        this._card.countdown.stop();
        this._card.setPaused(true);
    }

    // Pointing at the capsule or the card holds the notification and opens the card;
    // leaving lets it run out, with at least FLASH_RESUME_MS to go.
    _syncHover() {
        if (this._hoverTimeout) {
            GLib.source_remove(this._hoverTimeout);
            this._hoverTimeout = 0;
        }
        if (!this._flash)
            return;
        if (this._dateMenu.hover || this._card.hover) {
            this._holdFlash();
            this._openCard();
            return;
        }
        this._hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_LEAVE_MS, () => {
            this._hoverTimeout = 0;
            if (!this._flash.card)
                this._closeCard();
            if (!this._flashTimeout)
                this._runFlash(Math.max(this._flash.left ?? 0, FLASH_RESUME_MS));
            return GLib.SOURCE_REMOVE;
        });
    }

    _activateFlash() {
        const notification = this._flash?.notification;
        if (notification) {
            Main.overview.hide();
            notification.activate();
        }
        this._endFlash();
    }

    _endFlash() {
        if (!this._flash)
            return;
        this._dropFlash();
        this._sync();
    }

    // Forgets the notification without redrawing the capsule.
    _dropFlash() {
        for (const id of ['_flashTimeout', '_hoverTimeout']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = 0;
        }
        this._flash?.notification?.disconnectObject(this);
        this._flash = null;
        this._capsule?.countdown.stop();
        this._closeCard();
    }

    // ---- card --------------------------------------------------------------

    _openCard() {
        if (this._cardOpen)
            return;
        this._cardOpen = true;
        const card = this._card;
        card.remove_all_transitions();
        if (!card.visible) {
            card.set_pivot_point(0.5, 0);
            card.opacity = 0;
            card.scale_y = 0.92;
            card.translation_y = -6;
        }
        this._placeCard();
        // Again once the panel is laid out: the capsule may be mid-change.
        this._queuePlaceCard();
        card.show();
        card.ease({opacity: 255, scale_y: 1, translation_y: 0, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Centred under the capsule, kept on its monitor.
    _placeCard() {
        const button = this._dateMenu;
        const [x, y] = button.get_transformed_position();
        const [, width] = this._card.get_preferred_width(-1);
        const monitor = Main.layoutManager.primaryMonitor;
        const left = Math.round(x + button.width / 2 - width / 2);
        this._card.set_position(
            Math.max(monitor.x + CARD_GAP, Math.min(left, monitor.x + monitor.width - width - CARD_GAP)),
            Math.round(y + button.height + CARD_GAP));
    }

    _queuePlaceCard() {
        if (!this._cardOpen || this._placeLater)
            return;
        this._placeLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._placeLater = 0;
            if (this._cardOpen)
                this._placeCard();
            return GLib.SOURCE_REMOVE;
        });
    }

    _closeCard() {
        if (!this._cardOpen)
            return;
        this._cardOpen = false;
        this._card.ease({
            opacity: 0, translation_y: -6, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._cardOpen)
                    this._card?.hide();
            },
        });
    }

    // ---- calendar ----------------------------------------------------------

    _startCalendarHelper() {
        const helper = GLib.getenv('RICE_BAR_CALENDAR_HELPER') ?? `${this._path}/calendar_helper.py`;
        try {
            this._helper = Gio.Subprocess.new(['python3', '-I', helper],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (e) {
            console.warn(`rice-shell: calendar helper failed to start: ${e.message}`);
            return;
        }
        this._helperCancel = new Gio.Cancellable();
        this._helperOut = new Gio.DataInputStream({base_stream: this._helper.get_stdout_pipe()});
        this._readHelper();
    }

    _readHelper() {
        this._helperOut.read_line_async(GLib.PRIORITY_DEFAULT, this._helperCancel, (stream, result) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`rice-shell: calendar helper: ${e.message}`);
                return;
            }
            if (line === null)
                return;  // the helper exited
            try {
                this._events = JSON.parse(line).events ?? [];
                this._sync();
            } catch (e) {
                console.warn(`rice-shell: bad calendar helper output: ${e.message}`);
            }
            this._readHelper();
        });
    }

    _stopCalendarHelper() {
        this._helperCancel?.cancel();
        // Closing stdin tells the helper to exit.
        this._helper?.get_stdin_pipe()?.close(null);
        this._helper = null;
        this._helperOut = null;
        this._helperCancel = null;
    }

    _meetingState(now) {
        const event = this._events.find(e => e.start - MEETING_LEAD_MS <= now && now < e.start + MEETING_GRACE_MS);
        if (!event)
            return null;
        const minutes = Math.ceil((event.start - now) / 60000);
        return {
            kind: 'meeting',
            main: event.title,
            trail: minutes > 0 ? `in ${minutes}m` : 'now',
            gicon: new Gio.ThemedIcon({name: 'x-office-calendar-symbolic'}),
        };
    }

    // ---- capsule -----------------------------------------------------------

    _idleState() {
        const now = GLib.DateTime.new_now_local();
        const twelveHour = this._interface.get_string('clock-format') === '12h';
        return {
            kind: 'idle',
            lead: now.format('%a %-d %b'),
            main: now.format(twelveHour ? '%-l:%M %p' : '%H:%M'),
        };
    }

    _sync() {
        if (!this._capsule)
            return;
        const state = this._flash?.state ?? this._meetingState(Date.now()) ?? this._mediaState() ?? this._idleState();
        this._capsule.show(state);
    }
}
