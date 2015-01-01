/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * @license MPL 2.0
 * @copyright Joseph Carroll <jdsalingerjr@gmail.com>
 */
define(function(require, exports, module) {
    var PhysicsEngine = require('famous/physics/PhysicsEngine');
    var Particle = require('famous/physics/bodies/Particle');
    var Drag = require('famous/physics/forces/Drag');
    var Spring = require('famous/physics/forces/Spring');
    var Group = require('famous/core/Group');
    var Entity = require('famous/core/Entity');
    var Transform = require('famous/core/Transform');
    var Engine = require('famous/core/Engine');

    var EventHandler = require('famous/core/EventHandler');
    var OptionsManager = require('famous/core/OptionsManager');
    var ViewSequence = require('famous/core/ViewSequence');
    var FocusScrollLayout = require('./FocusScrollLayout');
    var Utility = require('famous/utilities/Utility');

    var GenericSync = require('famous/inputs/GenericSync');
    var ScrollSync = require('famous/inputs/ScrollSync');
    var TouchSync = require('famous/inputs/TouchSync');
    GenericSync.register({scroll : ScrollSync, touch : TouchSync});

    /** @const */
    var TOLERANCE = 0.5;

    /** @enum */
    var EdgeStates = {
        FIRST: -1,
        NONE:  0,
        LAST:  1
    };

    ScrollView.DEFAULT_LAYOUT = FocusScrollLayout;

    ScrollView.DEFAULT_OPTIONS = {
        syncs: ['scroll', 'touch'],
        rails: true,
        direction: Utility.Direction.Y,
        friction: 0.005,
        drag: 0.0001,
        speedLimit: 5,
        scale: 1
    }

    function ScrollView(options, layout) {
        // patch options with defaults
        this.options = Object.create(ScrollView.DEFAULT_OPTIONS);
        this._optionsManager = new OptionsManager(this.options);
        this.setOptions(options);
        
        // create sub-components
        layout = layout || ScrollView.DEFAULT_LAYOUT;
        this.setLayout(layout);

        this.sync = new GenericSync(
            this.options.syncs,
            {
                direction : this.options.direction,
                rails: this.options.rails
            }
        );

        this._physicsEngine = new PhysicsEngine();
        this._particle = new Particle();
        this._physicsEngine.addBody(this._particle);

        this.spring = new Spring();
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
        this._edgeState = EdgeStates.NONE;
        this._springAttached = false;
        this._node = null;
        this._earlyEnd = false;
        this._scale = 1;

        this._springPosition = 0;

        // eventing
        this._eventInput = new EventHandler();
        this._eventOutput = new EventHandler();

        this._eventInput.pipe(this.sync);
        this.sync.pipe(this._eventInput);

        EventHandler.setInputHandler(this, this._eventInput);
        EventHandler.setOutputHandler(this, this._eventOutput);

        _bindEvents.call(this);
    }

    function _handleStart(event) {
        // console.log('$START');
        _detachAgents.call(this);
        this._earlyEnd = false;

        if (this.drag.options.strength !== this.options.drag) {
            this.drag.options.strength = this.options.drag;
            this.friction.options.strength = this.options.friction
        }
    }

    function _handleMove(event) {
        // console.log('$MOVE');
        var velocity = event.velocity;
        var delta = event.delta;

        // Scale in the direction of
        if (this._scale !== 1 && this._edgeState !== EdgeStates.NONE) {
            if ((delta > 0 && this._edgeState === EdgeStates.FIRST)
                || (delta < 0 && this._edgeState === EdgeStates.LAST)) {
                velocity *= this._scale;
                delta *= this._scale;
            }
        }

        if (this._edgeState !== EdgeStates.NONE && event.slip) {
            if ((velocity < 0 && this._edgeState === EdgeStates.TOP) || (velocity > 0 && this._edgeState === EdgeStates.BOTTOM)) {
                if (!this._earlyEnd) {
                    _handleEnd.call(this, event);
                    this._earlyEnd = true;
                }
            }
            else if (this._earlyEnd && (Math.abs(velocity) > Math.abs(this.getVelocity()))) {
                _handleStart.call(this, event);
            }
        }
        if (this._earlyEnd) return;

        if (event.slip) {
            var speedLimit = this.options.speedLimit;
            if (velocity < -speedLimit) velocity = -speedLimit;
            else if (velocity > speedLimit) velocity = speedLimit;

            _setVelocity.call(this, velocity);

            var deltaLimit = speedLimit * 16;
            if (delta > deltaLimit) delta = deltaLimit;
            else if (delta < -deltaLimit) delta = -deltaLimit;
        }

        var currPos = _getPosition.call(this);
        _setPosition.call(this, currPos + delta);

        if (this._edgeState === EdgeStates.NONE) _normalizeState.call(this);
    }

    function _handleEnd(event) {
        // console.log('$END');
        var velocity = event.velocity;
        var delta = event.delta;
        
        // Scale in the direction of
        if (this._scale !== 1 && this._edgeState !== EdgeStates.NONE) {
            if ((delta > 0 && this._edgeState === EdgeStates.FIRST)
                || (delta < 0 && this._edgeState === EdgeStates.LAST)) {
                velocity *= this._scale;
                delta *= this._scale;
            }
        }

        var speedLimit = this.options.speedLimit;
        if (event.slip) speedLimit *= this.options.edgeGrip;
        if (velocity < -speedLimit) velocity = -speedLimit;
        else if (velocity > speedLimit) velocity = speedLimit;

        this._attachSpring = true;
        _attachAgents.call(this, this._edgeState !== EdgeStates.NONE);

        _setVelocity.call(this, velocity);
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
            // console.log('$ON_EDGE');
            _handleEdge.call(this, event);
            this._eventOutput.emit('onEdge', event);
        }.bind(this));

        this._layout.on('offEdge', function(event) {
            // console.error('$OFF_EDGE');
            _handleEdge.call(this, event);
            this._eventOutput.emit('offEdge', event);
        }.bind(this));

        this._particle.on('update', function(particle) {
            _normalizeState.call(this);
        }.bind(this));

        this._particle.on('end', function() {
            if (this._edgeState !== EdgeStates.NONE && this._attachSpring) {
                Engine.nextTick(function () {
                    _detachAgents.call(this);
                    _attachAgents.call(this, true);
                    this._attachSpring = false;
                }.bind(this));
            }
            this._eventOutput.emit('settle');
        }.bind(this));
    }

    function _attachAgents(spring) {
        if (spring) {
            // console.log('Spring attached');
            this._physicsEngine.attach([this.spring], this._particle);
            this._springAttached = true;
        }
        else {
            this._physicsEngine.attach([this.drag, this.friction], this._particle);
        }
    }

    function _detachAgents() {
        if (this._springAttached) {
            // console.log('Spring removed');
        }
        this._physicsEngine.detachAll();
        this._springAttached = false;
        _setVelocity.call(this, 0);
    }

    function _handleEdge(event) {
        if (event.firstEdgeVisible || event.lastEdgeVisible) {
            if (this._edgeState === EdgeStates.NONE) {

                // TODO: L2R
                if (event.firstEdgeVisible) this._edgeState = EdgeStates.FIRST;
                else this._edgeState = EdgeStates.LAST;

                this._scale = event.edgeGrip;

                // console.log('Spring position: ' + event.position);
                var springOptions = {
                    anchor: [event.position, 0, 0],
                    period: event.springPeriod,
                    dampingRatio: event.springDamp
                };
                this.spring.setOptions(springOptions);
            }
        }
        else if (this._edgeState !== EdgeStates.NONE) {
            this._scale = this.options.scale;
            this._edgeState = EdgeStates.NONE;
        }
    }

    function _normalizeState() {
        var node = this._node;
        var layout = this._layout;
        var lastPosition = this._lastPosition;

        // If we get to the edge by momentum, slow even faster
        if (this._edgeState !== EdgeStates.NONE) {
            if (this.drag.options.strength !== 0.01) {
                this.drag.options.strength = 0.01;
                this.friction.options.strength = 0.05;
            }
            return;
        }

        var normalized;
        var position = _getPosition.call(this);
        var size = layout.getNodeSize(node, 0);
        // console.log('Position: ' + position + ' Last Position: ' + this._lastPosition + ' Size: ' + size);
        if (position < -size) {
            if (layout.getNext instanceof Function) normalized = layout.getNext(node, 0);
            else normalized = node.getNext();
        } 
        else if (this._lastPosition <= 0 && position > 0) {
            if (layout.getPrevious instanceof Function) normalized = layout.getPrevious(node, 0);
            else normalized = node.getPrevious();

            if (normalized) size = -layout.getNodeSize(normalized, 0);
        }

        if (normalized) {
            _shiftOrigin.call(this, normalized, size);
        }
        this._lastPosition = _getPosition.call(this);
    }

    function _shiftOrigin(node, offset) {
        _setPosition.call(this, _getPosition.call(this) + offset);

        if (node) {
            var previousIndex = this._node.getIndex();
            this._node = node;
            var currIndex = this._node.getIndex();
            if (this._node.index !== previousIndex) {
                this._eventOutput.emit('pageChange', {direction: currIndex - previousIndex, index: currIndex});
            }
            // console.log('Active Index: ' + currIndex);
        } else {
            if (this._node) {
                this._node = null;
                this._eventOutput.emit('pageChange', {index: currIndex});
            }
        }
    }

    function _renderLayout() {
        var offset = _getPosition.call(this);
        var clipSize = this._size;
        return this._layout.renderLayout(this._node, offset, clipSize);
    }

    function _getPosition() {
        return this._particle.getPosition1D();
    };

    function _setPosition(x) {
        this._particle.setPosition1D(x);
    };

    function _getVelocity() {
        return this._particle.getVelocity1D();
    };

    function _setVelocity(v) {
        this._particle.setVelocity1D(v);
    };

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
        this._edgeState = EdgeStates.NONE;
        _detachAgents.call(this);


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
        if (layout instanceof Function) this._layout = new layout(this.options.layout);
        else this._layout = layout;

        if (options) this.setOptions({layout: options});
    };

    ScrollView.prototype.setOptions = function setOptions(options) {
        if (!options) return;

        if (options.direction !== undefined) {
            if (options.direction === 'x') options.direction = Utility.Direction.X;
            else if (options.direction === 'y') options.direction = Utility.Direction.Y;
            else if (options.direction === 'both') options.direction = undefined;
        }

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
                direction : this.options.direction,
                scale : this.options.syncScale,
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

        var position = _getPosition.call(this);
        var scrollTransform;
        if (this.options.direction === Utility.Direction.X) {
            scrollTransform = Transform.translate(position, 0);
        }
        else {
            scrollTransform = Transform.translate(0, position);
        }

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