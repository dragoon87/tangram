/*jslint browser: true*/
/*global Tangram, gui */

/*

Hello source-viewers!

We're glad you're interested in how Tangram can be used to make amazing maps!

This demo is meant to show off various visual styles, but it has a really complex setup - we had to jump through a lot of hoops to implement the style-switcher and rebuild the dat.gui interface on the fly, which are things you would probably never have to do in a real-world use case.

So instead of rummaging through this rather confusing example, we recommend you check out our documentation, which is chock-full of specific, targeted demos highlighting all of the nifty features of the Tangram library:

https://github.com/tangrams/tangram/wiki/

Enjoy!
- The Mapzen Tangram team

*/

(function () {

    var sources = ['landuse', 'water', 'transit', 'roads', 'buildings', 'places', 'pois'];
    var scene_url = 'demos/bubble-wrap-style-more-labels.yaml',
        osm_debug = false,
        rS, url_hash, map_start_location, url_style;
    var getfeatures = false;
    var marker = null;
    getValuesFromUrl();

    // default source, can be overriden by URL
    var map = L.map('map', {
            maxZoom: 20,
            zoomSnap: 0,
            trackResize: true,
            keyboard: false
        });
        
    window.lrmConfig = {
        serviceUrl: 'http://192.168.99.67:8000/route/v1',
        profile: 'driving',
    };
    // Searching within a bounding box
    var southWest = L.latLng(29.9766, 113.704);
    var northEast = L.latLng(31.3527, 115.082);
    var bounds = L.latLngBounds(southWest, northEast);
    
    waypoints = []//[ L.latLng(30.515, 114.3802), L.latLng(30.5075, 114.4025)];
    var routing_control = L.Routing.control(L.extend(window.lrmConfig, {
      plan: L.Routing.plan(waypoints, {geocoder: true,}),
      collapsible: true,
      routeWhileDragging: true,
      reverseWaypoints: true,
      showAlternatives: true,
      altLineOptions: {
		styles: [
			{color: 'black', opacity: 0.15, weight: 9},
			{color: 'white', opacity: 0.8, weight: 6},
			{color: 'blue', opacity: 0.5, weight: 2}
		]
	  },
      router: new L.Routing.OSRMv1({language: 'zh-Hans', serviceUrl: 'http://192.168.99.67:8000/route/v1'})
    })).addTo(map);  
    
    var has_routing = true;
        
    var lc = L.control.locate().addTo(map);
        
    // Add geocoder
    var geocoder = L.control.geocoder('', {
            url: 'https://192.168.99.67:3101/v1',
            layers: ['pois','address'],
            select: true,
            bounds: bounds,
            placeholder: 'Search within wuhan'// + bounds.toBBoxString()
        }).addTo(map);
        
    // Re-sort control order so that geocoder is on top
    var geocoderEl = geocoder._container;
    geocoderEl.parentNode.insertBefore(geocoderEl, geocoderEl.parentNode.childNodes[0]);

    // Focus to geocoder input
    geocoder.focus();

    var layer = Tangram.leafletLayer({
            scene: scene_url,
            //numWorkers: 4,
            rotate: true,
            introspection: true,
            events: {
                hover: onFeatureHover,
				click: onFeatureClick
            },
            preUpdate: preUpdate,
            postUpdate: postUpdate,
            // highDensityDisplay: false,
            // webGLContextOptions: { // explicitly add/override WebGL context options
            //     antialias: false
            // },
            // debug: {
            //     layer_stats: true // enable to collect detailed layer stats, access w/`scene.debug.layerStats()`
            // },
            logLevel: 'debug',
            //attribution: '<a href="https://mapzen.com/tangram" target="_blank">Tangram</a> | &copy; OSM contributors | <a href="https://mapzen.com/" target="_blank">Mapzen</a>'
        });

    map.pm.addControls({
        drawMarker: true,
        drawPolygon: true,
        editPolygon: true,
        drawPolyline: true,
        deleteLayer: true,
    });
    
    /*map.pm.enableDraw('Poly', {
        snappable: true,
        templineStyle: {
            color: 'blue',
        },
        hintlineStyle: {
            color: 'blue',
            dashArray: [5, 5],
        },
        pathOptions: {
            color: 'red',
            fillColor: 'orange',
            fillOpacity: 0.7,
        },
        cursorMarker: false,
        finishOnDoubleClick: true,
    });*/
    
    // useful events to subscribe to
    layer.scene.subscribe({
        load: function (msg) {
            // scene was loaded
            injectAPIKey(msg.config);
            var geojson_data = {};
            geojson_data['mz_default_line'] = {"properties":{},"type":"LineString","coordinates":[[111.68706,32.37968],[111.78706,32.47968]]}
            layer.scene.setDataSource('mz_default_line', { type: 'GeoJSON', data: geojson_data });
            layer.scene.rebuild() 
        },
        update: function (msg) {
            // scene was updated
            injectAPIKey(msg.config);
        },
        view_complete: function (msg) {
            // new set of map tiles was rendered
        },
        error: function (msg) {
            // debugger;
        },
        warning: function (msg) {
            // debugger;
        }
    });

    function injectAPIKey(config) {
        if (config.global && config.global.sdk_mapzen_api_key) {
            config.global.sdk_mapzen_api_key = 'mapzen-T3tPjn7';
        }
        else {
            for (var name in config.sources) {
                var source = config.sources[name];
                if (source.url.search('mapzen.com') > -1) {
                    source.url_params = source.url_params || {};
                    source.url_params.api_key = 'mapzen-T3tPjn7';
                }
            }
        }
    }

    /***** GUI/debug controls *****/

    /*** URL parsing ***/

    // URL hash pattern is one of:
    // #[zoom],[lat],[lng]
    // #[source],[zoom],[lat],[lng] (legacy)
    function getValuesFromUrl() {

        url_hash = window.location.hash.slice(1, window.location.hash.length).split('/');

        // Get location from URL
        //map_start_location = [16, 32.384724331168955, 111.673903381738475]; // NYC
        map_start_location = [16, 30.527, 114.34];

        if (url_hash.length >= 3) {
            // Note: backwards compatibility with old demo links, deprecate?
            if (typeof parseFloat(url_hash[0]) === 'number' && !isNaN(parseFloat(url_hash[0]))) {
                map_start_location = url_hash.slice(0, 3);
            }
            else if (typeof parseFloat(url_hash[1]) === 'number' && !isNaN(parseFloat(url_hash[1]))) {
                map_start_location = url_hash.slice(1, 4);
            }
        }

        if (url_hash.length > 3) {
            // Style on URL?
            var re = new RegExp(/(?:style|mode)=(\w+)/);
            url_hash.forEach(function(u) {
                var match = u.match(re);
                url_style = (match && match.length > 1 && match[1]);
            });
        }

    }

    // Put current state on URL
    var update_url_throttle = 100;
    var update_url_timeout = null;
    function updateURL() {
        clearTimeout(update_url_timeout);
        update_url_timeout = setTimeout(function() {
            var center = map.getCenter();
            var url_options = [map.getZoom(), center.lat, center.lng].map(function(v) { return v.toFixed(5); });

            if (rS) {
                url_options.push('rstats');
            }

            if (style_options && style_options.effect != '') {
                url_options.push('style=' + style_options.effect);
            }

            window.location.hash = url_options.join('/');
        }, update_url_throttle);
    }

    /*** Map ***/

    window.layer = layer;
    window.map = map;
    var scene = layer.scene;
    window.scene = scene;

    // Update URL hash on move
    map.attributionControl.setPrefix('');
    map.setView(map_start_location.slice(1, 3), map_start_location[0]);
    map.on('move', updateURL);

    // Render/GL stats: http://spite.github.io/rstats/
    // Activate with 'rstats' anywhere in options list in URL
    if (url_hash.indexOf('rstats') >= 0) {
        var glS = new glStats();
        glS.fractions = []; // turn this off till we need it

        rS = new rStats({
            values: {
                frame: { caption: 'Total frame time (ms)', over: 10 },
                raf: { caption: 'Time since last rAF (ms)' },
                fps: { caption: 'Framerate (FPS)', below: 40 },
                tiles: { caption: 'Rendered tiles' },
                geometry_count: { caption: '# geoms' },
                feature_count: { caption: '# features' },
                buffer_size: { caption: 'GL buffers (MB)' }
            },
            CSSPath : 'demos/lib/',
            plugins: [glS]
        });

        // Move it to the bottom-left so it doesn't obscure zoom controls
        var rSDOM = document.querySelector('.rs-base');
        rSDOM.style.bottom = '0px';
        rSDOM.style.top = 'inherit';
    }


    // For easier debugging access

    // GUI options for rendering style/effects
    var style_options = {
        effect: url_style || '',
        options: {
            'None': '',
            'Water animation': 'water',
            'Elevator': 'elevator',
            'Pop-up': 'popup',
            'Halftone': 'halftone',
            'Windows': 'windows',
            'Environment Map': 'envmap',
            'Rainbow': 'rainbow'
        },
        saveInitial: function() {
            this.initial = { config: JSON.stringify(scene.config) };
        },
        setup: function (style) {
            // Restore initial state
            scene.config = JSON.parse(this.initial.config);

            // Remove existing style-specific controls
            gui.removeFolder(this.folder);

            // Style-specific settings
            if (style != '') {
                if (this.settings[style] != null) {
                    var settings = this.settings[style] || {};

                    // Change projection if specified
                    if (settings.camera) {
                        scene.setActiveCamera(settings.camera);
                    }

                    // Style-specific setup function
                    if (settings.setup) {
                        settings.uniforms = function() {
                            return scene.styles[style] && scene.styles[style].shaders.uniforms;
                        };
                        settings.state = {}; // dat.gui needs a single object to old state

                        this.folder = style[0].toUpperCase() + style.slice(1); // capitalize first letter
                        settings.folder = gui.addFolder(this.folder);
                        settings.folder.open();

                        settings.setup(style);

                        if (settings.folder.__controllers.length === 0) {
                            gui.removeFolder(this.folder);
                        }
                    }

                    if (scene.config.layers.earth)
						scene.config.layers.earth.fill.enabled = true; // some custom shaders may need to render earth
                }
                else {
					if (scene.config.layers.earth)
						scene.config.layers.earth.fill.enabled = false; // don't need earth layer in default style
                }
            }

            // Recompile/rebuild
            scene.updateConfig();
            updateURL();

            // Force-update dat.gui
            for (var i in gui.__controllers) {
                gui.__controllers[i].updateDisplay();
            }
        },
        settings: {
            'water': {
                setup: function (style) {
					if (scene.config.layers.water.draw.polygons)
						scene.config.layers.water.draw.polygons.style = style;
					else if (scene.config.layers.water.draw.grid)
						scene.config.layers.water.draw.grid.style = style;
                }
            },
            'rainbow': {
                setup: function (style) {
					if (scene.config.layers.earth)
						scene.config.layers.earth.fill.draw.polygons.color = '#333';
                    scene.config.layers.roads.draw.lines.color = '#777';
                    scene.config.layers.pois.enabled = false;
                    scene.config.layers.buildings.polygons.draw.polygons.style = style;
                    scene.config.layers.buildings.polygons.extruded.draw.polygons.style = style;
                }
            },
            'popup': {
                setup: function (style) {
                    scene.config.layers.buildings.polygons.extruded.draw.polygons.style = style;
                }
            },
            'elevator': {
                setup: function (style) {
                    scene.config.layers.buildings.polygons.extruded.draw.polygons.style = style;
                }
            },
            'halftone': {
                setup: function (style) {
                    scene.config.scene.background.color = 'black';

                    var layers = scene.config.layers;
                    layers.earth.fill.draw.polygons.style = 'halftone_polygons';
                    layers.water.draw.polygons.style = 'halftone_polygons';
                    layers.landuse.areas.draw.polygons.style = 'halftone_polygons';
                    layers.buildings.polygons.draw.polygons.style = 'halftone_polygons';
                    layers.buildings.polygons.extruded.draw.polygons.style = 'halftone_polygons';
                    layers.buildings.polygons.draw.polygons.color = 'Style.color.pseudoRandomColor()';
                    layers.roads.draw.lines.style = 'halftone_lines';
                    layers.pois.enabled = false;

                    var enabled_layers = ['landuse', 'water', 'roads', 'buildings'];
                    Object.keys(layers).forEach(function(l) {
                        if (enabled_layers.indexOf(l) === -1) {
                            layers[l].enabled = false;
                        }
                    });
                }
            },
            'windows': {
                camera: 'isometric', // force isometric
                setup: function (style) {
                    scene.config.layers.earth.fill.draw.polygons.color = '#333';
                    scene.config.layers.roads.draw.lines.color = '#777';
                    scene.config.layers.pois.enabled = false;

                    scene.config.layers.buildings.polygons.draw.polygons.style = style;
                    scene.config.layers.buildings.polygons.extruded.draw.polygons.style = style;
                    // scene.config.layers.pois.enabled = false;
                }
            },
            'envmap': {
                setup: function (style) {
                    scene.config.layers.earth.fill.draw.polygons.color = '#333';
                    scene.config.layers.roads.draw.lines.color = '#777';

                    scene.config.layers.buildings.polygons.draw.polygons.style = style;
                    scene.config.layers.buildings.polygons.extruded.draw.polygons.style = style;

                    var envmaps = {
                        'Sunset': 'demos/images/sunset.jpg',
                        'Chrome': 'demos/images/LitSphere_test_02.jpg',
                        'Matte Red': 'demos/images/matball01.jpg',
                        'Color Wheel': 'demos/images/wheel.png'
                    };

                    this.state.envmap = envmaps['Sunset'];
                    this.folder.add(this.state, 'envmap', envmaps).onChange(function(value) {
                        scene.config.styles.envmap.material.emission.texture = value;
                        scene.load(scene.config, scene.config_path);
                    }.bind(this));
                }
            }
        },
        scaleColor: function (c, factor) { // convenience for converting between uniforms (0-1) and DAT colors (0-255)
            if ((typeof c == 'string' || c instanceof String) && c[0].charAt(0) == "#") {
                // convert from hex to rgb
                var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(c);
                c = result ? [
                    parseInt(result[1], 16),
                    parseInt(result[2], 16),
                    parseInt(result[3], 16)
                ] : null;
            }
            return [c[0] * factor, c[1] * factor, c[2] * factor];
        }
    };

    // Create dat GUI
    var gui = new dat.GUI({ autoPlace: true });
    function addGUI () {
        gui.domElement.parentNode.style.zIndex = 10000;
        window.gui = gui;

        // Add ability to remove a whole folder from DAT.gui
        gui.removeFolder = function(name) {
            var folder = this.__folders[name];
            if (folder == null) {
                return;
            }

            folder.close();
            folder.__ul.parentNode.removeChild(folder.__ul);
            this.__folders[name] = undefined;
            this.onResize();
        };

        // Language selector
        var langs = {
            '(default)': null,
            'English': 'en',
            'Russian': 'ru',
            'Japanese': 'ja',
            'German': 'de',
            'French': 'fr',
            'Arabic': 'ar',
            'Hindi': 'hi',
            'Spanish': 'es'
        };
        /*gui.language = 'en';
        gui.add(gui, 'language', langs).onChange(function(value, key) {
            scene.config.global.language = (value == 'null') ? null  : value; // dat.gui coerces null to string 'null'
            scene.updateConfig();
        });*/
		
		// style template selector
        var templates = {
            'bubble-wrap': 'bubble-wrap-style-more-labels',
            'cinnabar': 'cinnabar-style-more-labels',
            'refill': 'refill-style-more-labels',
            'tron': 'tron-style-more-labels',
            'walkabout': 'walkabout-style-more-labels',
            'zinc': 'zinc-style-more-labels',
            '基础图（常规版）': 'laohekou-basemap-common',
            '基础图（灰色版）': 'laohekou-basemap-gray',
            '基础图（灰色版）-交通': 'laohekou-basemap-gray-traffic',
            '城市市政综合监管': 'laohekou-chengguan',
            '应急': 'laohekou-emergency',
            '地下管线': 'laohekou-pipe',
            '规划0616': 'laohekou-program'
        };
        gui.template = templates['bubble-wrap']//templates[Object.keys(templates).sort((a,b)=>a-b)[0]];
        gui.add(gui, 'template', templates).onChange(function(value, key) {
            gui.removeFolder('Layers');
            
			scene.load('demos/' + value + '.yaml');
            scene.updateConfig();
            layer.scene = scene;
            
            layer_gui = gui.addFolder('Layers');
            var layer_controls = {};
            Object.keys(layer.scene.config.layers).forEach(function(l) {
                var ll = layer.scene.config.layers[l];
                if (!ll)
                    return;
                var src = ll.data.layer;
                if (src === undefined)
                    src = l;
                if (sources.indexOf(src) < 0)
                    return;
                layer_controls[l] = !(layer.scene.config.layers[l].enabled == false);
                layer_gui.
                    add(layer_controls, l).
                    onChange(function(value) {
                        layer.scene.config.layers[l].enabled = value;
                        layer.scene.rebuild();
                    });
            });
        });

        // Camera
        var camera_types = {
            'Flat': 'flat',
            'Perspective': 'perspective',
            'Isometric': 'isometric'
        };
        gui.camera = scene.getActiveCamera();
        /*test_gui = gui.addFolder('tests');
        test_test_gui = test_gui.addFolder('tests');
        var obj = test_test_gui.add(gui, 'camera', camera_types);
        obj.onChange(function(value) {
            var att = this.property;
            var type = $(this).parents('ul').child('.title');
            scene.setActiveCamera(value);
        });*/

        // Feature selection on hover
        gui['features info'] = false;
        gui.add(gui, 'features info').onChange(function(value) {
            getfeatures = value;
        });
        gui['debug'] = osm_debug;
        gui.add(gui, 'debug').onChange(function(value) {
            osm_debug = value;
            if (osm_debug) {
                window.osm_layer =
                L.tileLayer(
                    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                    {
                        maxZoom: 19//,
                    })
                .addTo(map);
                layer.bringToFront();
            } else {
                window.osm_layer.remove();
            }
        });

        // Take a screenshot and save to file
        gui.screenshot = function () {
            return scene.screenshot().then(function(screenshot) {
                // uses FileSaver.js: https://github.com/eligrey/FileSaver.js/
                saveAs(screenshot.blob, 'tangram-' + (+new Date()) + '.png');
            });
        };
        gui.add(gui, 'screenshot');

        // Take a video capture and save to file
        if (typeof window.MediaRecorder == 'function') {
            gui.video = function () {
                if (!gui.video_capture) {
                    if (scene.startVideoCapture()) {
                        gui.video_capture = true;
                        gui.video_button.name('stop video');
                    }
                }
                else {
                    return scene.stopVideoCapture().then(function(video) {
                        gui.video_capture = false;
                        gui.video_button.name('capture video');
                        saveAs(video.blob, 'tangram-video-' + (+new Date()) + '.webm');
                    });
                }
            };
            gui.video_button = gui.add(gui, 'video');
            gui.video_button.name('capture video');
            gui.video_capture = false;
        }

        // Layers
        var layer_gui = gui.addFolder('Layers');
        var layer_controls = {};
        var cur_zoom = map.getZoom();
        Object.keys(layer.scene.config.layers).forEach(function(l) {
            var ll = layer.scene.config.layers[l];
            if (!ll)
                return;
            var src = ll.data.layer;
            if (src === undefined)
                src = l;
            if (sources.indexOf(src) < 0)
                return;

            layer_controls[l] = !(layer.scene.config.layers[l].enabled == false);
            layer_gui.
                add(layer_controls, l).
                onChange(function(value) {
                    layer.scene.config.layers[l].enabled = value;
                    layer.scene.rebuild();
                });
        });

        // Styles
        //gui.add(style_options, 'effect', style_options.options).
        //    onChange(style_options.setup.bind(style_options));

        // Link to edit in OSM - alt-click
        /*window.addEventListener('click', function () {
            if (key.alt) {
                var url = 'https://www.openstreetmap.org/edit?';
                var center = map.getCenter();
                url += '#map=' + map.getZoom() + '/' + center.lat + '/' + center.lng;
                window.open(url, '_blank');
            }
        });*/
		
		//document.getElementsByClassName("close-button")[0].click();
    }

    if (has_routing)
        gui.closed = true;
    // Feature selection
    var selection_info = document.createElement('div'); // shown on hover
    selection_info.setAttribute('class', 'label');
    selection_info.style.display = 'block';

	function onFeatureClick (selection) {
        if (marker) {
            map.removeLayer(marker);
            marker = null;
        }
        gui.removeFolder('selection');
        // Show selection info
        var feature = selection.feature;
        if (getfeatures) {
            //scene.save();
            var features = scene.getFeaturesAt(selection.leaflet_event.latlng, { scale:map.getZoom(), radius:1 })
            if (features.length == 0)
                return;
            var label = '';
            for (var i = 0; i < features.length; i ++) {
                label += `<b>source:</b> ${features[i].source_layer}<br>`;
                //Object.keys(features[i].layers).forEach(p => label += `<b>layer${p}:</b> ${feature.layers[p]}<br>`);
            }
            marker = L.marker(selection.leaflet_event.latlng,
                    {draggable: true,        // 使图标可拖拽
                    title: 'Text',           // 添加一个标题
                    opacity: 0}            // 设置透明度
                    )
                    .addTo(map)
                    .bindPopup('<span class="labelInner">' + label + '</span>')
                    .openPopup();
        }
        else if (feature != null && feature.properties != null) {
            var label = '';
            label += `<b>key:</b> ${feature.tile.key}<br>`;
            Object.keys(feature.layers).forEach(p => label += `<b>layer${p}:</b> ${feature.layers[p]}<br>`);
            Object.keys(feature.properties).forEach(p => label += `<b>${p}:</b> ${feature.properties[p]}<br>`);
            //label += JSON.stringify(scene.getActiveStyles(feature));
            gui.removeFolder('selection');
            var selection_gui = gui.addFolder('selection');
            scene.getActiveStyles(feature, selection_gui);

            if (label != '') {
                marker = L.marker(selection.leaflet_event.latlng,
                    {draggable: true,        // 使图标可拖拽
                    title: 'Text',           // 添加一个标题
                    opacity: 0}            // 设置透明度
                    )
                    .addTo(map)
                    .bindPopup('<span class="labelInner">' + label + '</span>')
                    .openPopup();
            }
        }
        
        if (marker != null) {
            L.DomEvent.on(document.getElementsByClassName("leaflet-popup-close-button")[0], 'click', function (e) {
                map.removeLayer(marker);
                marker = null;
            });
        }
    }

    function onFeatureHover (selection) {
        // Show selection info
        var feature = selection.feature;
        if (feature != null && feature.properties != null) {
            var label = '';
            if (feature.properties.name != null) {
                label = feature.properties.name;
            }
            if (feature.properties.NAME != null) {
                label = feature.properties.NAME;
            }
			if (feature.properties.NAME_CHN != null) {
                label = feature.properties.NAME_CHN;
            }
			if (feature.properties.BNAME != null) {
                label = feature.properties.BNAME;
            }
            //Object.keys(feature.properties).forEach(p => label += `<b>${p}:</b> ${feature.properties[p]}<br>`);

            if (label != '') {
                selection_info.style.left = (selection.pixel.x + 5) + 'px';
                selection_info.style.top = (selection.pixel.y + 15) + 'px';
                selection_info.innerHTML = '<span class="labelInner">' + label + '</span>';
                if (selection_info.parentNode == null) {
                    map.getContainer().appendChild(selection_info);
                }
            }
            else if (selection_info.parentNode != null) {
                selection_info.parentNode.removeChild(selection_info);
            }
        }
        else if (selection_info.parentNode != null) {
            selection_info.parentNode.removeChild(selection_info);
        }
    }

    // Pre-render hook
    var zoom_step = 0.03;
    function preUpdate (will_render) {
        // Input
        if (key.isPressed('up')) {
            map._move(map.getCenter(), map.getZoom() + zoom_step);
            map._moveEnd(true);
        }
        else if (key.isPressed('down')) {
            map._move(map.getCenter(), map.getZoom() - zoom_step);
            map._moveEnd(true);
        }
        else if (key.isPressed('esc')) {
            if (marker) {
                map.removeLayer(marker);
                marker = null;
            }
            gui.removeFolder('selection');
        }

        // Profiling
        if (rS) {
            rS('fps').frame();
            if (will_render) {
                rS('frame').start();
                glS.start();
            }
        }
    }

    // Post-render hook
    function postUpdate () {
        if (rS != null) { // rstats
            rS('frame').end();
            rS('tiles').set(scene.debug.renderableTilesCount());
            rS('buffer_size').set((scene.tile_manager.getDebugSum('buffer_size') / (1024*1024)).toFixed(2));
            rS('geometry_count').set(scene.tile_manager.getDebugSum('geometry_count'));
            rS('feature_count').set(scene.tile_manager.getDebugSum('feature_count'));
            rS().update();
        }
    }

    /***** Render loop *****/
    window.addEventListener('load', function () {
        // Scene initialized
        layer.on('init', function() {
            addGUI();

            style_options.saveInitial();
            if (url_style) {
                style_options.setup(url_style);
            }
            updateURL();
        });
        layer.addTo(map);
        
        if (osm_debug == true) {
            window.osm_layer =
                L.tileLayer(
                    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                    // 'https://stamen-tiles.a.ssl.fastly.net/terrain-background/{z}/{x}/{y}.jpg',
                    {
                        maxZoom: 19//,
                        // opacity: 0.5
                    })
                .addTo(map);
                // .bringToFront();
        }

        layer.bringToFront();
        //map.setZoom(18);
        //map.setView([30.527, 114.34], 16);
        
    });


}());
