/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * @license MPL 2.0
 * @copyright Joseph Carroll <jdsalingerjr@gmail.com>
 */
define(function(require, exports, module) {
    'use strict';

    var PhysicsEngine = require('famous/physics/PhysicsEngine');
    var Particle = require('famous/physics/bodies/Particle');
    var Drag = require('famous/physics/forces/Drag');
    var Spring = require('famous/physics/forces/Spring');
    var Group = require('famous/core/Group');
    var Entity = require('famous/core/Entity');
    var Transform = require('famous/core/Transform');
    var Engine = require('famous/core/Engine');
    var Vector = require('famous/math/Vector');

    var EventHandler = require('famous/core/EventHandler');
    var OptionsManager = require('famous/core/OptionsManager');
    var ViewSequence = require('famous/core/ViewSequence');
    var FocusScrollLayout = require('./FocusScrollLayout');
    var Utility = require('famous/utilities/Utility');
    var ScrollEdgeStates = require('./ScrollEdgeStates');

    var GenericSync = require('famous/inputs/GenericSync');
    var ScrollSync = require('famous/inputs/ScrollSync');
    var TouchSync = require('famous/inputs/TouchSync');
    GenericSync.register({scroll: ScrollSync, touch: TouchSync});

    function ScrollView(options, layout) {
        // patch options with defaults
        this.options = Object.create(ScrollView.DEFAULT_OPTIONS);
        this._optionsManager = new OptionsManager(this.options);
        this.setOptions(options);

        this._eventInput = new EventHandler();
        this._eventOutput = new EventHandler();

        EventHandler.setInputHandler(this, this._eventInput);
        EventHandler.setOutputHandler(this, this._eventOutput);

        // create sub-components
        layout = layout || ScrollView.DEFAULT_LAYOUT;
        this.setLayout(layout);

        this.sync = new GenericSync(
            this.options.syncs,
            {
                // direction : this.options.direction,
                // rails: this.options.rails
            }
        );

        this._physicsEngine = new PhysicsEngine();
        this._particle = new Particle();
        this._physicsEngine.addBody(this._particle);

        this._springAgent = -1;
        this.spring = new Spring();

        this._dragAgent = -1;
        this.drag = new Drag({
            forceFunction: Drag.FORCE_FUNCTIONS.QUADRATIC,
            strength: this.options.drag
        });
        this.friction = new Drag({
            forceFunction: Drag.FORCE_FUNCTIONS.LINEAR,
            strength: this.options.friction
        });

        if (this.options.clipSize !== undefined) return this.options.clipSize;


        // Create new context to manage elements
        this._group = new Group();
        this._group.add({render: _renderLayout.bind(this)});
        this._entityId = Entity.register(this);

        // state
        this._edgeState = ScrollEdgeStates.NONE;
        this._springAttached = false;
        this._node = null;
        this._earlyEnd = false;
        this._scale = 1;

        this._springPosition = 0;

        // eventing
        this._eventInput.pipe(this.sync);
        this.sync.pipe(this._eventInput);

        _bindEvents.call(this);
    }

    ScrollView.DEFAULT_LAYOUT = FocusScrollLayout;

    ScrollView.DEFAULT_OPTIONS = {
        syncs: ['scroll', 'touch'],
        rails: true,
        direction: Utility.Direction.Y,
        friction: 0.005,
        drag: -0.0001,
        speedLimit: 5,
        scale: 1
    };

    function _handleStart(event) {
        // console.log('$START');
        this._touchMove = true;
        console.log('$REMOVE_AGENTS - START');
        _detachAgents.call(this, true, true);
        this._earlyEnd = false;

        if (this.drag.options.strength !== this.options.drag) {
            this.drag.options.strength = this.options.drag;
            this.friction.options.strength = this.options.friction;
        }
    }

    function _handleMove(event) {
        var edgeState = this._edgeState;

        // console.log('$MOVE');
        var velocity;
        var delta;
        if (this.options.direction === Utility.Direction.X) {
            delta = event.delta[0];
            velocity = event.velocity[0];
        }
        else {
            delta = event.delta[1];
            velocity = event.velocity[1];
        }

        // Scale in the direction of
        if (this._gripScale !== 1 && this._edgeState !== ScrollEdgeStates.NONE) {
            if ((delta > 0 && this._edgeState === ScrollEdgeStates.FIRST)
                || (delta < 0 && this._edgeState === ScrollEdgeStates.LAST)) {
                velocity *= this._scale;
                delta *= this._scale;
            }
        }

        if (window.$move)
            console.log('Delta: ' + delta + ' Velocity: ' + velocity);

        if ((edgeState === ScrollEdgeStates.FIRST || edgeState === ScrollEdgeStates.LAST) && event.slip) {
            if ((velocity < 0 && edgeState === ScrollEdgeStates.FIRST) || (velocity > 0 && edgeState === ScrollEdgeStates.LAST)) {
                if (!this._earlyEnd) {
                    _handleEnd.call(this, event);
                    this._earlyEnd = true;
                }
            }
            else if (this._earlyEnd && Math.abs(velocity) > Math.abs(this.getVelocity())) {
                _handleStart.call(this, event);
            }
        }
        if (this._earlyEnd) {
            console.log('$EARLY_END');
            return;
        }

        if (event.slip) {
            var speedLimit = this.options.speedLimit;
            if (velocity < -speedLimit) velocity = -speedLimit;
            else if (velocity > speedLimit) velocity = speedLimit;

            _setVelocity.call(this, velocity);

            var deltaLimit = speedLimit * 16;
            if (delta > deltaLimit) delta = deltaLimit;
            else if (delta < -deltaLimit) delta = -deltaLimit;
        }
        else this._touchVelocity = velocity;

        var currPos = _getPosition.call(this);
        _setPosition.call(this, currPos + delta);

        console.log('$NORMALIZE_MOVE');
        _normalizeState.call(this, true);
    }

    function _handleEnd(event) {
        var edgeState = this._edgeState;

        // console.log('$END');
        var velocity;
        var delta;
        if (this.options.direction === Utility.Direction.X) {
            delta = event.delta[0];
            velocity = event.velocity[0];
        }
        else {
            delta = event.delta[1];
            velocity = event.velocity[1];
        }

        // Scale in the direction of
        if (this._gripScale !== 1 && this._edgeState !== ScrollEdgeStates.NONE) {
            if ((delta > 0 && this._edgeState === ScrollEdgeStates.FIRST)
                || (delta < 0 && this._edgeState === ScrollEdgeStates.LAST)) {
                velocity *= this._scale;
                delta *= this._scale;
            }
        }

        var speedLimit = this.options.speedLimit;
        if (event.slip) speedLimit *= this.options.edgeGrip;
        if (velocity < -speedLimit) velocity = -speedLimit;
        else if (velocity > speedLimit) velocity = speedLimit;

        var setSpring = edgeState !== ScrollEdgeStates.NONE;
        this._attachSpring = !setSpring;
        console.log('$ATTACH_AGENTS - END Spring: ' + setSpring + ' Drag: ' + true);
        _attachAgents.call(this, setSpring, true);

        this._touchVelocity = null;
        _setVelocity.call(this, velocity);
        this._touchMove = false;
    }

    function _bindEvents() {
        this._eventInput.bindThis(this);
        this._eventInput.on('start', _handleStart);
        this._eventInput.on('update', _handleMove);
        this._eventInput.on('end', _handleEnd);

        this._eventInput.on('resize', function() {
            if (this._node) this._node._.calculateSize();
        }.bind(this));

        this._layout.on('onEdge', function(event) {
            console.log('$ON_EDGE Edge: ' + event.edge);
            _handleEdge.call(this, event);
            this._eventOutput.emit('onEdge', event);
        }.bind(this));

        this._layout.on('offEdge', function(event) {
            console.log('$OFF_EDGE');
            _handleEdge.call(this, event);
            this._eventOutput.emit('offEdge', event);
        }.bind(this));

        this._particle.on('update', function(particle) {
            Engine.nextTick(function() {
                console.log('$NORMALIZE_UPDATE');
                _normalizeState.call(this, false);
            }.bind(this));
        }.bind(this));

        this._particle.on('end', function() {
            // This could be dangerous...
            // We could have a situation where the spring was attached once, settled and then attached again
            console.error('$SETTLE Touch: ' + this._touchMove + ' Edge: ' + this._edgeState);
            if (this._attachSpring) {
                if (!this._touchMove && this._edgeState !== ScrollEdgeStates.NONE) {
                    Engine.nextTick(function () {
                        console.log('$REMOVE_AGENTS - SETTLE(t) Spring: ' + true + ' Drag: ' + true);
                        _detachAgents.call(this, true, true);
                        console.log('$ATTACH_AGENTS - SETTLE Spring: ' + true + ' Drag: ' + false);
                        _attachAgents.call(this, true, false);
                        this._attachSpring = false;
                    }.bind(this));
                }
            }
            else {
                Engine.nextTick(function () {
                    if (!this._touchMove) {
                        console.log('$REMOVE_AGENTS - SETTLE(f) Spring: ' + true + ' Drag: ' + true);
                        _detachAgents.call(this, true, true);
                    }
                }.bind(this));
            }
            this._eventOutput.emit('settle');
        }.bind(this));
    }

    function _attachAgents(spring) {
        if (spring && this._springAgent === -1) {
            this._springAgent = this._physicsEngine.attach(this.spring, this._particle);
            this._springAttached = true;
        }
        if (this._dragAgent === -1) {
            this._dragAgent = this._physicsEngine.attach(this.drag, this._particle);
            this._frictionAgent = this._physicsEngine.attach(this.friction, this._particle);
        }
    }

    function _detachAgents(spring, drag) {
        if (spring && this._springAgent >= 0) {
            this._physicsEngine.detach(this._springAgent);
            this._springAgent = -1;
            this._springAttached = false;
        }
        if (drag && this._dragAgent >= 0) {
            this._physicsEngine.detach(this._dragAgent);
            this._dragAgent = -1;

            _setVelocity.call(this, 0);

            this._physicsEngine.detach(this._frictionAgent);
            this._frictionAgent = -1;
        }
    }

    function _handleEdge(event) {
        this._edgeState = event.edge;

        if (event.edge === ScrollEdgeStates.NONE) {
            this._scale = this.options.scale;

            if (this._springAttached) {
                console.log('$REMOVE_AGENTS - Edge Spring: ' + true + ' Drag: ' + false);
                _detachAgents.call(this, true, false);
            }
        }
        else {
            this._scale = event.scale;

            var options;
            var springOptions = this.spring.options;
            var anchor = new Vector(event.anchor);
            if (!springOptions.anchor || !anchor.equals(springOptions.anchor)) {
                if (!options) options = {};
                // console.log('Spring position: ' + anchor);
                options.anchor = anchor;
            }
            if (event.period !== springOptions.period) {
                if (!options) options = {};
                options.period = event.period;
            }
            if (event.dampingRatio !== springOptions.dampingRatio) {
                if (!options) options = {};
                options.dampingRatio = event.dampingRatio;
            }

            if (!this._springAttached && !this._touchMove) {
                console.log('$ATTACH_AGENTS - Edge Spring: ' + true + ' Drag: ' + false);
                _attachAgents.call(this, true, false);
            }

            if (options) {
                console.log('$SET_SPRING Anchor: ' + options.anchor);
                this.spring.setOptions(options);
            }
        }
    }

    function _normalizeState(move) {
        var node = this._node;
        var layout = this._layout;
        var edgeState = this._edgeState;

        // Don't normalize when we are on an actual edge
        if (edgeState === ScrollEdgeStates.FIRST || edgeState === ScrollEdgeStates.LAST) {
        // If we get to the edge by momentum, slow even faster
            if (!move && this.drag.options.strength !== 0.01) {
                this.drag.options.strength = 0.01;
                this.friction.options.strength = 0.05;
            }
            return;
        }

        var position = _getPosition.call(this);
        var velocity = _getVelocity.call(this);
        var normalized = layout.getNormalizedPosition(node, position, velocity, this._size);

        if (normalized) {
            _shiftOrigin.call(this, normalized.node, normalized.size);
        }
    }

    function _shiftOrigin(node, offset) {
        console.log('$REMOVE_AGENTS Shift Spring: true Drag: true');
        var velocity = _getVelocity.call(this);
        var spring = this._springAgent >= 0;
        _detachAgents.call(this, true, true);
        _setPosition.call(this, _getPosition.call(this) + offset);
        if (!this._touchMove) {
            console.log('$ATTACH_AGENTS Shift Spring: ' + spring + ' Drag: ' + true);
            _attachAgents.call(this, spring, true);
            _setVelocity.call(this, velocity);
        }

        if (node) {
            var previousIndex = this._node.getIndex();
            this._node = node;
            var currIndex = this._node.getIndex();
            if (this._node.index !== previousIndex) {
                this._eventOutput.emit('pageChange', {direction: currIndex - previousIndex, index: currIndex});
            }
            // console.log('Active Index: ' + currIndex);
        }
        else if (this._node) {
            this._node = null;
            this._eventOutput.emit('pageChange', {index: -1});
        }
    }

    function _renderLayout() {
        var position = _getPosition.call(this);
        var velocity = _getVelocity.call(this);
        var clipSize = this._size;
        return this._layout.renderLayout(this._node, position, velocity, clipSize);
    }

    function _getPosition() {
        // Particle.getPosition should only be called on the commit
        return this._commitPosition;
    }

    function _setPosition(x) {
        this._commitPosition = x;
        this._particle.setPosition1D(x);
    }

    function _getVelocity() {
        if (this._touchVelocity) {
            return this._touchVelocity;
        }
        return this._particle.getVelocity1D();
    }

    function _setVelocity(v) {
        this._particle.setVelocity1D(v);
    }

    ScrollView.prototype.getActiveIndex = function getActiveIndex() {
        if (this._node) return this._node.getIndex();
        return -1;
    };

    ScrollView.prototype.scrollNext = function scrollNext() {
        if (this._node) {
            var next = this._node.getNext();
            if (next) scrollTo(next.getIndex());
        }
    };

    ScrollView.prototype.scrollPrevious = function scrollPrevious() {
        if (this._node) {
            var previous = this._node.getPrevious();
            if (previous) scrollTo(previous.getIndex());
        }
    };

    ScrollView.prototype.scrollTo = function scrollTo(index) {
        if (!this._node) return;

        // first return the group to a 0 state
        _setPosition.call(this, 0);
        this._edgeState = ScrollEdgeStates.NONE;
        _detachAgents.call(this, true, true);


        // then walk from the current index to the desired index
        var currNode = this._node;
        var currIndex = currNode.getIndex();
        while (currIndex !== index) {
            if (currIndex < index) currNode = currNode.getNext();
            else currNode = currNode.getPrevious();
            currIndex = currNode.getIndex();
        }
        _shiftOrigin.call(this, currNode, 0);
    };

    ScrollView.prototype.getLayout = function getLayout() {
        return this._layout;
    };

    ScrollView.prototype.setLayout = function setLayout(layout, options) {
        if (options) this.setOptions({layout: options});

        if (layout instanceof Function) this._layout = new layout(this.options.layout);
        else {
            this._layout = layout;
            this._layout.setOptions(this.options.layout);
        }
    };

    ScrollView.prototype.setOptions = function setOptions(options) {
        if (!options) return;

        options.layout = options.layout || {};

        if (options.direction === 'x') options.direction = Utility.Direction.X;
        else options.direction = Utility.Direction.Y;

        options.layout.direction = options.direction;
        options.layout.view = this;

        // patch custom options
        this._optionsManager.setOptions(options);

        // layout sub-component
        if (options.layout && this._layout) this._layout.setOptions(this.options.layout);

        // physics sub-components
        if (options.drag !== undefined && this.drag) this.drag.setOptions({strength: this.options.drag});
        if (options.friction !== undefined && this.friction) this.friction.setOptions({strength: this.options.friction});

        // sync sub-component
        if ((options.rails !== undefined || options.direction !== undefined || options.syncScale !== undefined) && this.sync) {
            this.sync.setOptions({
                direction: this.options.direction,
                scale: this.options.syncScale,
                rails: this.options.rails
            });
        }
    };

    ScrollView.prototype.sequenceFrom = function sequenceFrom(node) {
        if (node instanceof Array) node = new ViewSequence({array: node, trackSize: true});
        this._node = node;
    };

    // Internal API

    ScrollView.prototype.render = function render() {
        if (!this._node || !this._layout) return null;
        return this._entityId;
    };

    ScrollView.prototype.commit = function commit(context) {
        var transform = context.transform;
        var opacity = context.opacity;
        var origin = context.origin;
        this._size = context.size;

        // Particle.getPosition should only be called on the commit
        var position = this._particle.getPosition1D();
        this._commitPosition = position;
        // var velocity = _getVelocity.call(this);
        // if (velocity !== 0 && velocity < 0.001 && !this._touchMove) {
        //     console.log('Force 0 velocity');
        //     _setVelocity.call(this, 0);
        // }
        var scrollTransform;
        if (this.options.direction === Utility.Direction.X) scrollTransform = Transform.translate(position, 0);
        else scrollTransform = Transform.translate(0, position);

        return {
            transform: Transform.multiply(transform, scrollTransform),
            size: this._size,
            opacity: opacity,
            origin: origin,
            target: this._group.render()
        };
    };

    module.exports = ScrollView;
});
