import Utils from './utils/utils';
import Thread from './utils/thread';
import Scene from './scene';
import Geo from './geo';
import debounce from './utils/debounce';
import {mergeDebugSettings} from './utils/debug_settings';

// Exports must appear outside a function, but will only be defined in main thread (below)
export var LeafletLayer;
export function leafletLayer(options) {
    return extendLeaflet(options);
}

function extendLeaflet(options) {

    // If LeafletLayer is already defined when this is called just return that immediately
    // e.g. if you call leafletLayer multiple times (which is valid)
    if (typeof LeafletLayer !== 'undefined') {
        return new LeafletLayer(options);
    }

    // Leaflet layer functionality is only defined in main thread
    if (Thread.is_main) {
        const inertiaLinearity = 0.25;
        const inertiaMaxSpeed = 180;
        const inertiaDeceleration = 720;
        let L = options.leaflet || window.L;

        // Determine if we are extending the leaflet 0.7.x TileLayer class, or the newer
        // leaflet 1.x GridLayer class.
        let layerBaseClass = L.GridLayer ? L.GridLayer : L.TileLayer;
        let leafletVersion = layerBaseClass === L.GridLayer ? '1.x' : '0.7.x';
        let layerClassConfig = {};
        let setZoomAroundNoMoveEnd; // alternate zoom functions defined below

        // If extending leaflet 0.7.x TileLayer, additional modifications are needed
        if (layerBaseClass === L.TileLayer) {
            layerClassConfig._addTile = function(){};
            layerClassConfig._removeTile = function(){};
            layerClassConfig._reset = function() {
                layerBaseClass.prototype._reset.apply(this, arguments);
                // re-add the canvas since base class `viewreset` event can remove it
                if (this.scene && this.scene.container && this.scene.canvas) {
                    this.scene.container.appendChild(this.scene.canvas);
                }
            };
        }

        // Define custom layer methods
        Object.assign(layerClassConfig, {

            initialize (options) {
                // Defaults
                options.showDebug = (!options.showDebug ? false : true);

                L.setOptions(this, options);
                this.updateTangramDebugSettings();
                this.createScene();
                this.hooks = {};
                this._updating_tangram = false;
                this._zoomAnimated = false; // turn leaflet zoom animations off for this layer
                
                this._el = options.element || this.scene.canvas;
                this._bearingSnap = options.bearingSnap || 0;
                this._pitchWithRotate = options.pitchWithRotate !== false;
                this._button = options.button || 'right';
                this._pos = {x : 0, y : 0};
                this._rotate = options.rotate;
                
                if (this._rotate) {
                    Utils.bindAll([
                        '_onRotateDown',
                        '_onRotateMove',
                        '_onRotateUp',
                        '_rotateCompassArrow'
                    ], this);
                    
                    this._compass = L.DomUtil.create('a', 'leaflet-control-compass', document.getElementsByClassName('leaflet-control-zoom')[0]);
                    //this._compass.type = 'button';
                    this._compass.setAttribute('aria-label', 'Reset North');
                    this._compass.setAttribute('href', '#');
                    this._compass.addEventListener('click', () => this.resetNorth());
                    this._compassArrow = L.DomUtil.create('span', 'leaflet-control-compass-arrow', this._compass);
                }
            },
            
             _rotateCompassArrow() {
                if (this.scene.view.camera !== undefined) 
                    this._compassArrow.style.transform = `rotate(${this.scene.view.camera.getBearing()}deg)`;
                else
                    this._compassArrow.style.transform = `rotate(0deg)`;
            },

            createScene () {
                this.scene = Scene.create(
                    this.options.scene,
                    {
                        numWorkers: this.options.numWorkers,
                        preUpdate: this.options.preUpdate,
                        postUpdate: this.options.postUpdate,
                        continuousZoom: (LeafletLayer.leafletVersion === '1.x'),
                        wrapView: (this.options.noWrap === true ? false : true),
                        highDensityDisplay: this.options.highDensityDisplay,
                        logLevel: this.options.logLevel,
                        introspection: this.options.introspection,
                        webGLContextOptions: this.options.webGLContextOptions, // override/supplement WebGL context options
                        disableRenderLoop: this.options.disableRenderLoop // app must call scene.update() per frame
                    });
            },
            
            mousePos (el, e) {
                const rect = el.getBoundingClientRect();
                e = e.touches ? e.touches[0] : e;
                return {
                    x : e.clientX - rect.left - el.clientLeft,
                    y : e.clientY - rect.top - el.clientTop
                };
            },
            
            _drainInertiaBuffer() {
                const inertia = this._inertia,
                    now = Date.now(),
                    cutoff = 160;   //msec

                while (inertia.length > 0 && now - inertia[0][0] > cutoff)
                    inertia.shift();
            },
            
            _normalizeBearing (bearing, currentBearing) {
                bearing = Utils.wrap(bearing, -180, 180);
                const diff = Math.abs(bearing - currentBearing);
                if (Math.abs(bearing - 360 - currentBearing) < diff) bearing -= 360;
                if (Math.abs(bearing + 360 - currentBearing) < diff) bearing += 360;
                return bearing;
            },
            
            _fireEvent (type, e) {
                return this._map.fire(type, { originalEvent: e });
            },
    
            _onRotateMove (e) {
                if (!this._rotate_active) {
                    this._rotate_active = true;
                    this._map.moving = true;
                    this._fireEvent('rotatestart', e);
                    this._fireEvent('movestart', e);
                    if (this._pitchWithRotate) {
                        this._fireEvent('pitchstart', e);
                    }
                }

                const map = this._map;
                map.stop();
                
                this._el = this.scene.canvas;
                const p1 = this._pos,
                    p2 = this.mousePos(this.scene.canvas, e),
                    bearingDiff = (p1.x - p2.x) * 0.8,
                    pitchDiff = (p1.y - p2.y) * -0.5,
                    bearing = this.scene.view.camera.getBearing() - bearingDiff,
                    pitch = this.scene.view.camera.getPitch() - pitchDiff,
                    inertia = this._inertia,
                    last = inertia[inertia.length - 1];

                this._drainInertiaBuffer();
                inertia.push([Date.now(), this._normalizeBearing(bearing, last[1])]);

                //console.log("bearing:"+bearing)
                if (Math.abs(bearing) <= 180)
                    this.scene.view.camera.setBearing(bearing);
                if (this._pitchWithRotate && Math.abs(pitch) <= 90) {
                    this._fireEvent('pitch', e);
                    //console.log("pitch:"+pitch)
                    this.scene.view.camera.setPitch(pitch);
                }

                this._fireEvent('rotate', e);
                this._fireEvent('move', e);

                this._pos = p2;
            },
            
            _onRotateDown (e) {
                //if (this._map.boxZoom && this._map.boxZoom.isActive()) return;//À­¿òËõ·Å
                //if (this._map.dragPan && this._map.dragPan.isActive()) return;//Æ½ÒÆ
                if (this._rotate_active) return;

                if (this._button === 'right') {
                    const button = (e.ctrlKey ? 0 : 2);   // ? ctrl+left button : right button
                    let eventButton = e.button;
                    if (typeof window.InstallTrigger !== 'undefined' && e.button === 2 && e.ctrlKey &&
                        window.navigator.platform.toUpperCase().indexOf('MAC') >= 0) {
                        // Fix for https://github.com/mapbox/mapbox-gl-js/issues/3131:
                        // Firefox (detected by InstallTrigger) on Mac determines e.button = 2 when
                        // using Control + left click
                        eventButton = 0;
                    }
                    if (eventButton !== button) return;
                } else {
                    if (e.ctrlKey || e.button !== 0) return;
                }

                //DOM.disableDrag();

                window.document.addEventListener('mousemove', this._onRotateMove, {capture: true});
                window.document.addEventListener('mouseup', this._onRotateUp);
                /* Deactivate DragRotate when the window looses focus. Otherwise if a mouseup occurs when the window isn't in focus, DragRotate will still be active even though the mouse is no longer pressed. */
                window.addEventListener('blur', this._onRotateUp);

                this._rotate_active = false;
                this._inertia = [[Date.now(), this.scene.view.camera.getBearing()]];
                this._startPos = this._pos = this.mousePos(this.scene.canvas, e);
                //this._center = this._map.transform.centerPoint;  // Center of rotation

                e.preventDefault();
            },
            
            /*easeTo (options, eventData) {
                this.stop();

                options = util.extend({
                    offset: [0, 0],
                    duration: 500,
                    easing: util.ease
                }, options);

                if (options.animate === false) options.duration = 0;

                if (options.smoothEasing && options.duration !== 0) {
                    options.easing = this._smoothOutEasing(options.duration);
                }

                const tr = this.transform,
                    startZoom = this.getZoom(),
                    startBearing = this.getBearing(),
                    startPitch = this.getPitch(),

                    zoom = 'zoom' in options ? +options.zoom : startZoom,
                    bearing = 'bearing' in options ? this._normalizeBearing(options.bearing, startBearing) : startBearing,
                    pitch = 'pitch' in options ? +options.pitch : startPitch;

                const pointAtOffset = tr.centerPoint.add(Point.convert(options.offset));
                const locationAtOffset = tr.pointLocation(pointAtOffset);
                const center = LngLat.convert(options.center || locationAtOffset);
                this._normalizeCenter(center);

                const from = tr.project(locationAtOffset);
                const delta = tr.project(center).sub(from);
                const finalScale = tr.zoomScale(zoom - startZoom);

                let around, aroundPoint;

                if (options.around) {
                    around = LngLat.convert(options.around);
                    aroundPoint = tr.locationPoint(around);
                }

                this.zooming = (zoom !== startZoom);
                this.rotating = (startBearing !== bearing);
                this.pitching = (pitch !== startPitch);

                this._prepareEase(eventData, options.noMoveStart);

                clearTimeout(this._onEaseEnd);

                this._ease(function (k) {
                    if (this.zooming) {
                        tr.zoom = interpolate(startZoom, zoom, k);
                    }
                    if (this.rotating) {
                        tr.bearing = interpolate(startBearing, bearing, k);
                    }
                    if (this.pitching) {
                        tr.pitch = interpolate(startPitch, pitch, k);
                    }

                    if (around) {
                        tr.setLocationAtPoint(around, aroundPoint);
                    } else {
                        const scale = tr.zoomScale(tr.zoom - startZoom);
                        const base = zoom > startZoom ?
                            Math.min(2, finalScale) :
                            Math.max(0.5, finalScale);
                        const speedup = Math.pow(base, 1 - k);
                        const newCenter = tr.unproject(from.add(delta.mult(k * speedup)).mult(scale));
                        tr.setLocationAtPoint(tr.renderWorldCopies ? newCenter.wrap() : newCenter, pointAtOffset);
                    }

                    this._fireMoveEvents(eventData);

                }, () => {
                    if (options.delayEndEvents) {
                        this._onEaseEnd = setTimeout(() => this._easeToEnd(eventData), options.delayEndEvents);
                    } else {
                        this._easeToEnd(eventData);
                    }
                }, options);

                return this;
            }
            
            rotateTo (bearing, options , eventData) {
                return this.easeTo(util.extend({
                    bearing: bearing
                }, options), eventData);
            },*/
            
            resetNorth (options, eventData) {
                //this.rotateTo(0, util.extend({duration: 1000}, options), eventData);
                this.scene.view.camera.setBearing(0);
                this.scene.dirty = true;
                this.scene.update();
                this._rotateCompassArrow();
                return this;
            },
            
            _onRotateUp(e) {
                window.document.removeEventListener('mousemove', this._onRotateMove, {capture: true});
                window.document.removeEventListener('mouseup', this._onRotateUp);
                window.removeEventListener('blur', this._onRotateUp);

                //DOM.enableDrag();

                if (!this._rotate_active) return;

                this._rotate_active = false;
                this._fireEvent('rotateend', e);
                this._drainInertiaBuffer();

                const map = this._map,
                    mapBearing = this.scene.view.camera.getBearing(),
                    inertia = this._inertia;

                const finish = () => {
                    if (Math.abs(mapBearing) < this._bearingSnap) {
                        this.resetNorth({noMoveStart: true}, { originalEvent: e });
                    } else {
                        this._map.moving = false;
                        this._fireEvent('moveend', e);
                    }
                    if (this._pitchWithRotate) this._fireEvent('pitchend', e);
                };

                if (inertia.length < 2) {
                    finish();
                    return;
                }

                const first = inertia[0],
                    last = inertia[inertia.length - 1],
                    previous = inertia[inertia.length - 2];
                let bearing = this._normalizeBearing(mapBearing, previous[1]);
                const flingDiff = last[1] - first[1],
                    sign = flingDiff < 0 ? -1 : 1,
                    flingDuration = (last[0] - first[0]) / 1000;

                if (flingDiff === 0 || flingDuration === 0) {
                    finish();
                    return;
                }

                let speed = Math.abs(flingDiff * (inertiaLinearity / flingDuration));  // deg/s
                if (speed > inertiaMaxSpeed) {
                    speed = inertiaMaxSpeed;
                }

                const duration = speed / (inertiaDeceleration * inertiaLinearity),
                    offset = sign * speed * (duration / 2);

                bearing += offset;

                if (Math.abs(this._normalizeBearing(bearing, 0)) < this._bearingSnap) {
                    bearing = this._normalizeBearing(0, bearing);
                }

                this.scene.view.camera.setBearing(bearing);
                /*map.rotateTo(bearing, {
                    duration: duration * 1000,
                    easing: inertiaEasing,
                    noMoveStart: true
                }, { originalEvent: e });*/
            },

            // Finish initializing scene and setup events when layer is added to map
            onAdd (map) {
                if (!this.scene) {
                    this.createScene();
                }

                layerBaseClass.prototype.onAdd.apply(this, arguments);

                this.hooks.resize = () => {
                    this._updating_tangram = true;
                    this.updateSize();
                    this._updating_tangram = false;
                };
                map.on('resize', this.hooks.resize);

                this.hooks.move = () => {
                    if (this._updating_tangram) {
                        return;
                    }
                    this._updating_tangram = true;

                    this.scene.view.setPanning(true);
                    var view = map.getCenter();
                    view.zoom = Math.max(Math.min(map.getZoom(), map.getMaxZoom() || Geo.default_view_max_zoom), map.getMinZoom());

                    this.scene.view.setView(view);
                    if (this._mapLayerCount > 1) {
                        // if there are other map pane layers active, redraw immediately to stay in better visual sync
                        // otherwise, wait until next regular animation loop iteration
                        this.scene.immediateRedraw();
                    }

                    this._updating_tangram = false;
                };
                map.on('move', this.hooks.move);

                this.hooks.moveend = () => {
                    this.scene.view.setPanning(false);
                    this.scene.requestRedraw();
                };
                map.on('moveend', this.hooks.moveend);

                this.hooks.drag = () => {
                    this.scene.view.markUserInput();
                };
                map.on('drag', this.hooks.drag);

                // keep Tangram layer in sync with view via mutation observer
                this._map_pane_observer = new MutationObserver(mutations => {
                    mutations.forEach(mutation => this.reverseTransform());
                });
                this._map_pane_observer.observe(map.getPanes().mapPane, { attributes: true });

                // Modify default Leaflet behaviors
                this.modifyScrollWheelBehavior(map);
                this.modifyZoomBehavior(map);

                this.trackMapLayerCounts(map);

                // Setup feature selection
                this.setupSelectionEventHandlers(map);
                this.setSelectionEvents(this.options.events, { radius: this.options.selectionRadius });

                // Add GL canvas to layer container
                this.scene.container = this.getContainer();
                this.updateSize();

                // Initial view
                this.updateView();
                this.resizeOnFirstVisible();

                // Subscribe to tangram events
                this.scene.subscribe({
                    move: this.onTangramViewUpdate.bind(this)
                });

                // Use leaflet's existing event system as the callback mechanism
                this.scene.load(
                    this.options.scene,
                    {
                        base_path: this.options.sceneBasePath,
                        file_type: this.options.sceneFileType,
                        blocking: false
                    }).then(() => {

                    this._updating_tangram = true;

                    this.updateSize();
                    this.updateView();
                    // this.reverseTransform();

                    this._updating_tangram = false;

                    this.fire('init');
                }).catch(error => {
                    this.fire('error', error);
                });
                
                if (this._rotate) {
                    this._map.on('rotate', this._rotateCompassArrow);
                    this._rotateCompassArrow();
                    this.scene.canvas.addEventListener('mousedown', this._onRotateDown);
                }
            },

            onRemove (map) {
                layerBaseClass.prototype.onRemove.apply(this, arguments);

                map.off('layeradd layerremove overlayadd overlayremove', this._updateMapLayerCount);
                map.off('resize', this.hooks.resize);
                map.off('move', this.hooks.move);
                map.off('moveend', this.hooks.moveend);
                map.off('drag', this.hooks.drag);
                map.off('click', this.hooks.click);
                map.off('mousemove', this.hooks.mousemove);
                map.off('mouseout', this.hooks.mouseout);
                document.removeEventListener('visibilitychange', this.hooks.visibilitychange);
                this.hooks = {};

                this._map_pane_observer.disconnect();

                if (this.scene) {
                    this.scene.destroy();
                    this.scene = null;
                }
                
                if (this._rotate)
                    map.off('rotate', this._rotateCompassArrow);
            },

            createTile (coords) {
                var key = coords.x + '/' + coords.y + '/' + coords.z;
                var div = document.createElement('div');
                div.setAttribute('data-tile-key', key);
                div.style.width = '256px';
                div.style.height = '256px';

                if (this.options.showDebug) {
                    var debug_overlay = document.createElement('div');
                    debug_overlay.textContent = key;
                    debug_overlay.style.position = 'absolute';
                    debug_overlay.style.left = 0;
                    debug_overlay.style.top = 0;
                    debug_overlay.style.color = 'white';
                    debug_overlay.style.fontSize = '16px';
                    debug_overlay.style.textOutline = '1px #000000';
                    debug_overlay.style.padding = '8px';

                    div.appendChild(debug_overlay);
                    div.style.borderStyle = 'solid';
                    div.style.borderColor = 'white';
                    div.style.borderWidth = '1px';
                }

                return div;
            },

            // Modify leaflet's default scroll wheel behavior to render frames more frequently
            // (should generally lead to smoother scroll with Tangram frame re-render)
            modifyScrollWheelBehavior (map) {
                if (this.scene.view.continuous_zoom && map.scrollWheelZoom && this.options.modifyScrollWheel !== false) {
                    map.options.zoomSnap = 0;

                    const enabled = map.scrollWheelZoom.enabled();
                    map.scrollWheelZoom.disable();

                    // Chrome and Safari have smoother scroll-zoom without actively throttling the mouse wheel,
                    // while FF and Edge/IE do better with throttling.
                    // TODO: may be related to syncing differences with requestAnimationFrame loop, investigate further
                    if (L.Browser.chrome || L.Browser.safari) {
                        map.scrollWheelZoom._onWheelScroll = function (e) {
                            var delta = L.DomEvent.getWheelDelta(e);
                            this._delta += delta;
                            this._lastMousePos = this._map.mouseEventToContainerPoint(e);
                            this._performZoom();
                            L.DomEvent.stop(e);
                        };
                    }
                    else {
                        map.options.wheelDebounceTime = 20; // better default for FF and Edge/IE
                    }

                    const debounceMoveEnd = debounce(
                        function(map) {
                            map._moveEnd(true);
                            map.fire('viewreset'); // keep other leaflet layers in sync
                        },
                        map.options.wheelDebounceTime * 2
                    );

                    var layer = this;
                    map.scrollWheelZoom._performZoom = function () {
                        var map = this._map,
                            zoom = map.getZoom();

                        map._stop(); // stop panning and fly animations if any

                        var delta = this._delta / (this._map.options.wheelPxPerZoomLevel * 4);
                        this._delta = 0;

                        if ((zoom + delta) >= this._map.getMaxZoom()) {
                            delta = this._map.getMaxZoom() - zoom; // don't go past max zoom
                        }
                        else if ((zoom + delta) <= this._map.getMinZoom()) {
                            delta = this._map.getMinZoom() - zoom; // don't go past min zoom
                        }

                        if (!delta) { return; }

                        if (map.options.scrollWheelZoom === 'center') {
                            setZoomAroundNoMoveEnd(layer, map.getCenter(), zoom + delta);
                        } else {
                            setZoomAroundNoMoveEnd(layer, this._lastMousePos, zoom + delta);
                        }
                        debounceMoveEnd(map);
                    };

                    if (enabled) {
                        map.scrollWheelZoom.enable();
                    }
                }
            },

            // Modify leaflet's default double-click and zoom in/out behavior, to better keep Tangram layer in sync with marker/SVG layers
            modifyZoomBehavior (map) {
                if (this.scene.view.continuous_zoom && this.options.modifyZoomBehavior !== false) {
                    var layer = this;

                    // Simplified version of Leaflet's flyTo, for short animations zooming around a point
                    const flyAround = function (layer, targetCenter, targetZoom) {
                        map._stop();

                        var startZoom = map._zoom;

                        targetCenter = L.latLng(targetCenter);
                        targetZoom = targetZoom === undefined ? startZoom : targetZoom;
                        targetZoom = Math.min(targetZoom, map.getMaxZoom()); // don't go past max zoom

                        var from = map.project(map.getCenter(), startZoom),
                            to = map.project(targetCenter, startZoom);

                        var start = Date.now(),
                            duration = 75;

                        function frame() {
                            var t = (Date.now() - start) / duration;

                            if (t <= 1) {
                                // reuse internal flyTo frame to ensure these animations are canceled like others
                                map._flyToFrame = L.Util.requestAnimFrame(frame, map);

                                var center = from.add(to.subtract(from).multiplyBy(t));
                                center = [center.x, center.y];
                                center = Geo.metersToLatLng(center);
                                setZoomAroundNoMoveEnd(layer, targetCenter, startZoom + (targetZoom - startZoom) * t);
                            } else {
                                setZoomAroundNoMoveEnd(layer, targetCenter, targetZoom)
                                    ._moveEnd(true);
                            }
                        }

                        map._moveStart(true);

                        frame.call(map);
                        return map;
                    };

                    // Modify the double-click zoom handler to do a short zoom animation
                    // See original: https://github.com/Leaflet/Leaflet/blob/cf518ff1a5e0e54a2f63faa144aeaa50888e0bc6/src/map/handler/Map.DoubleClickZoom.js#L29
                    if (map.doubleClickZoom) {
                        const enabled = map.doubleClickZoom.enabled();
                        map.doubleClickZoom.disable();

                        map.doubleClickZoom._onDoubleClick = function (e) {
                            var map = this._map,
                                oldZoom = map.getZoom(),
                                delta = map.options.zoomDelta,
                                zoom = e.originalEvent.shiftKey ? oldZoom - delta : oldZoom + delta;

                            if (map.options.doubleClickZoom === 'center') {
                                flyAround(layer, map.getCenter(), zoom);
                            } else {
                                flyAround(layer, map.containerPointToLatLng(e.containerPoint), zoom);
                            }
                        };

                        if (enabled) {
                            map.doubleClickZoom.enable();
                        }
                    }

                    // Modify the zoom in/out behavior
                    // NOTE: this will NOT fire the 'zoomanim' event, so this modification should be disabled for apps that depend on it
                    // See original: https://github.com/Leaflet/Leaflet/blob/cf518ff1a5e0e54a2f63faa144aeaa50888e0bc6/src/map/Map.js#L1610
                    if (map._zoomAnimated) {
                        map._animateZoom = function (center, zoom, startAnim, noUpdate) {
                            if (startAnim) {
                                this._animatingZoom = true;

                                // remember what center/zoom to set after animation
                                this._animateToCenter = center;
                                this._animateToZoom = zoom;

                                // replace leaflet CSS animation with Tangram animation to keep markers/SVG in sync
                                // (this is a workaround from not being able to easily track/sync to on-going CSS animations in JS)
                                flyAround(layer, center, zoom);
                            }

                            // Work around webkit not firing 'transitionend', see https://github.com/Leaflet/Leaflet/issues/3689, 2693
                            setTimeout(L.Util.bind(this._onZoomTransitionEnd, this), 250);
                        };
                    }
                }
            },

            updateView () {
                var view = this._map.getCenter();
                view.zoom = Math.max(Math.min(this._map.getZoom(), this._map.getMaxZoom() || Geo.default_view_max_zoom), this._map.getMinZoom());
                this.scene.view.setView(view);
            },

            updateSize () {
                var size = this._map.getSize();
                this.scene.resizeMap(size.x, size.y);
            },

            resizeOnFirstVisible () {
                let first_visibility = true;
                this.hooks.visibilitychange = () => {
                    if (first_visibility) {
                        first_visibility = false;
                        this.updateSize();
                    }
                };

                document.addEventListener('visibilitychange', this.hooks.visibilitychange);
            },

            onTangramViewUpdate () {
                if (!this._map || this._updating_tangram) {
                    return;
                }

                // View changed?
                let map_center = this._map.getCenter();
                let view_center = this.scene.view.center;
                if (map_center.lng === view_center.lng &&
                    map_center.lat === view_center.lat &&
                    this._map.getZoom() === this.scene.view.zoom) {
                    return;
                }

                this._updating_tangram = true;
                this._map.setView([this.scene.view.center.lat, this.scene.view.center.lng], this.scene.view.zoom, { animate: false });
                this._updating_tangram = false;
            },

            render () {
                if (!this.scene) {
                    return;
                }
                this.scene.update();
            },

            // Reverse the CSS positioning Leaflet applies to the layer, since Tangram's WebGL canvas
            // is expected to be 'absolutely' positioned.
            reverseTransform () {
                if (!this._map || !this.scene || !this.scene.container) {
                    return;
                }

                var top_left = this._map.containerPointToLayerPoint([0, 0]);
                L.DomUtil.setPosition(this.scene.container, top_left);
            },
            
            onDiv: function (pixel, div) {
                var divs = document.getElementsByClassName(div);
                for (var i in divs) {
                    div = divs[i];
                
                    var x = pixel.x;
                    var y = pixel.y;
                    var x1 = div.offsetLeft;
                    var y1 = div.offsetTop;
                    var x2 = div.offsetLeft + div.offsetWidth;
                    var y2 = div.offsetTop + div.offsetHeight;
                    if(x >= x1 && x <= x2 && y >= y1 && y <= y2)
                        return true;
                }
                
                return false;
            },

            // Tie Leaflet event handlers to Tangram feature selection
            setupSelectionEventHandlers (map) {
                this._selection_events = {};
                this._selection_radius = null; // optional radius

                this.hooks.click = (event) => {
                    if (this.onDiv(event.containerPoint, "leaflet-control")) {
                        this._selection_events.hover(Object.assign({}, null, { leaflet_event: event }));
                        return;
                    }
                    if (typeof this._selection_events.click === 'function') {
                        this.scene.getFeatureAt(event.containerPoint, { radius: this._selection_radius }).
                            then(selection => {
                                let results = Object.assign({}, selection, { leaflet_event: event });
                                this._selection_events.click(results);
                            });
                    }
                };
                map.on('click', this.hooks.click);

                this.hooks.mousemove = (event) => {
                    if (this.onDiv(event.containerPoint, "leaflet-control")) {
                        this._selection_events.hover(Object.assign({}, null, { leaflet_event: event }));
                        return;
                    }
                    if (typeof this._selection_events.hover === 'function') {
                        this.scene.getFeatureAt(event.containerPoint, { radius: this._selection_radius }).
                            then(selection => {
                                let results = Object.assign({}, selection, { leaflet_event: event });
                                this._selection_events.hover(results);
                            });
                    }
                };
                map.on('mousemove', this.hooks.mousemove);

                this.hooks.mouseout = (event) => {
                    // When mouse leaves map, send an additional selection event to indicate no feature is selected
                    if (typeof this._selection_events.hover === 'function') {
                        this._selection_events.hover({ changed: true, leaflet_event: event });
                    }
                };
                map.on('mouseout', this.hooks.mouseout);
            },

            // Set user-defined handlers for feature selection events
            // Currently only one handler can be defined for each event type
            // Event types are: `click`, `hover` (leaflet `mousemove`)
            setSelectionEvents (events, { radius } = {}) {
                this._selection_events = Object.assign(this._selection_events, events);
                this._selection_radius = (radius !== undefined) ? radius : this._selection_radius;
            },

            // Track the # of layers in the map pane
            // Used to optimize Tangram redraw sensitivity (redraw more frequently when needing to sync w/other layers)
            trackMapLayerCounts (map) {
                this._updateMapLayerCount = () => {
                    let nodes = map.getPanes().mapPane.childNodes;
                    this._mapLayerCount = 0;
                    for (let i=0; i < nodes.length; i++) {
                        this._mapLayerCount += nodes[i].childNodes.length;
                    }
                };

                map.on('layeradd layerremove overlayadd overlayremove', this._updateMapLayerCount);
                this._updateMapLayerCount();
            },

            updateTangramDebugSettings () {
                mergeDebugSettings(this.options.debug || {});
            }

        });

        // Modified version of Leaflet's setZoomAround that doesn't trigger a moveEnd event
        setZoomAroundNoMoveEnd = function (layer, latlng, zoom) {
            var map = layer._map,
                scene = layer.scene,
                scale = map.getZoomScale(zoom),
                viewHalf = map.getSize().divideBy(2),
                containerPoint = latlng instanceof L.Point ? latlng : map.latLngToContainerPoint(latlng),

                centerOffset = containerPoint.subtract(viewHalf).multiplyBy(1 - 1 / scale),
                newCenter = map.containerPointToLatLng(viewHalf.add(centerOffset));

            if (scene) {
                scene.view.markUserInput();
            }
            return map._move(newCenter, zoom, { flyTo: true });
        };

        // Create the layer class
        LeafletLayer = layerBaseClass.extend(layerClassConfig);

        // Polyfill some 1.0 methods
        if (typeof LeafletLayer.remove !== 'function') {
            LeafletLayer.prototype.remove = function() {
                if (this._map) {
                    this._map.removeLayer(this);
                }
                this.fire('remove');
            };
        }

        LeafletLayer.layerBaseClass = layerBaseClass;
        LeafletLayer.leafletVersion = leafletVersion;

        return new LeafletLayer(options);
    }
}
