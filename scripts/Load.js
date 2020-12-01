	function getShader(gl, id) {
		var shaderScript = document.getElementById(id);
		var str = "";
		var k = shaderScript.firstChild;
		while (k) {
			if (k.nodeType == 3)
				str += k.textContent;
			k = k.nextSibling;
		}
		var shader;
		if (shaderScript.type == "x-shader/x-fragment")
			shader = gl.createShader(gl.FRAGMENT_SHADER);
		else if (shaderScript.type == "x-shader/x-vertex")
			shader = gl.createShader(gl.VERTEX_SHADER);
		else
			return null;
		gl.shaderSource(shader, str);
		gl.compileShader(shader);
		if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) == 0)
			alert(gl.getShaderInfoLog(shader));
		return shader;
	}

	requestAnimFrame = (function() {
		return window.webkitRequestAnimationFrame || window.mozRequestAnimationFrame || function(callback, element) {
			setTimeout(callback, 1000 / 60);
		};
	})();

	var gl;
	var prog_advance;
	var prog_composite;
	var prog_blur_horizontal;
	var prog_blur_vertical;
	var FBO_main;
	var FBO_main2;
	var FBO_helper;
	var FBO_blur;
	var FBO_noise;
	var texture_main_l; // main, linear
	var texture_main_n; // main, nearest (accurate pixel access on the same buffer)
	var texture_main2_l; // main double buffer, linear
	var texture_main2_n; // main double buffer, nearest (accurate pixel access on the same buffer)
	var texture_helper; // to be used when a buffer for multi-pass shader programs is needed (2-pass Gaussian blur)
	var texture_blur; // blur result
	var texture_noise_n; // noise pixel accurate
	var texture_noise_l; // noise interpolated pixel access

	var halted = false;
	var delay = 3;
	var it = 1;
	var frames = 0;
	var fps = 60; // no hurdle for DX10 graphics cards
	var time;
	var mouseX = 0.5;
	var mouseY = 0.5;
	var animation;
	var timer;
	// texture size (must be powers of two, remember 2048x1024 flat could also be a 128x128x128 voxel)
	var sizeX = 1024;
	var sizeY = 1024; // 2048x1024 flat or 128x128x128 cube
	// viewport size
	var viewX = 2048;
	var viewY = 1024;

	function load() {
		clearInterval(timer);
		var c = document.getElementById("c");
		try {
			gl = c.getContext("experimental-webgl", { depth : false });
		} catch (e) {
		}
/* 		if (!gl) {
			alert("Your browser does not support WebGL");
			return;
		} */
		document.onmousemove = function(evt) {
			mouseX = evt.pageX / viewX;
			mouseY = 1 - evt.pageY / viewY;
		};
		document.onclick = function(evt) {
			halted = !halted;
		};
		c.width = viewX;
		c.height = viewY;

		prog_advance = gl.createProgram();
		gl.attachShader(prog_advance, getShader(gl, "shader-vs"));
		gl.attachShader(prog_advance, getShader(gl, "shader-fs-advance"));
		gl.linkProgram(prog_advance);

		prog_composite = gl.createProgram();
		gl.attachShader(prog_composite, getShader(gl, "shader-vs"));
		gl.attachShader(prog_composite, getShader(gl, "shader-fs-composite"));
		gl.linkProgram(prog_composite);

		prog_blur_horizontal = gl.createProgram();
		gl.attachShader(prog_blur_horizontal, getShader(gl, "shader-vs"));
		gl.attachShader(prog_blur_horizontal, getShader(gl, "shader-fs-blur-horizontal"));
		gl.linkProgram(prog_blur_horizontal);

		prog_blur_vertical = gl.createProgram();
		gl.attachShader(prog_blur_vertical, getShader(gl, "shader-vs"));
		gl.attachShader(prog_blur_vertical, getShader(gl, "shader-fs-blur-vertical"));
		gl.linkProgram(prog_blur_vertical);

		var posBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);

		var vertices = new Float32Array([ -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0 ]);

		var aPosLoc = gl.getAttribLocation(prog_advance, "aPos");
		gl.enableVertexAttribArray(aPosLoc);

		var aTexLoc = gl.getAttribLocation(prog_advance, "aTexCoord");
		gl.enableVertexAttribArray(aTexLoc);

		var texCoords = new Float32Array([ 0, 0, 1, 0, 0, 1, 1, 1 ]);

		var texCoordOffset = vertices.byteLength;

		gl.bufferData(gl.ARRAY_BUFFER, texCoordOffset + texCoords.byteLength, gl.STATIC_DRAW);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
		gl.bufferSubData(gl.ARRAY_BUFFER, texCoordOffset, texCoords);
		gl.vertexAttribPointer(aPosLoc, 3, gl.FLOAT, gl.FALSE, 0, 0);
		gl.vertexAttribPointer(aTexLoc, 2, gl.FLOAT, gl.FALSE, 0, texCoordOffset);

		var noisepixels = [];
		var pixels = [];
		for ( var i = 0; i < sizeX; i++) {
			for ( var j = 0; j < sizeY; j++) {
				noisepixels.push(Math.random() * 255, Math.random() * 255, Math.random() * 255, 255);
				pixels.push(255, 0, 0, 0);
			}
		}
		/*
		 * if (Math.random() > density) pixels.push(0, 0, 0, 0); else pixels.push(255, 0, 0, 0);
		 */

		var rawData = new Uint8Array(noisepixels);
		texture_main_l = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture_main_l);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sizeX, sizeY, 0, gl.RGBA, gl.UNSIGNED_BYTE, rawData);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

		texture_main_n = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture_main_n);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sizeX, sizeY, 0, gl.RGBA, gl.UNSIGNED_BYTE, rawData);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

		rawData = new Uint8Array(noisepixels);
		rawData = new Uint8Array(noisepixels);
		texture_main2_l = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture_main2_l);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sizeX, sizeY, 0, gl.RGBA, gl.UNSIGNED_BYTE, rawData);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

		texture_main2_n = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture_main2_n);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sizeX, sizeY, 0, gl.RGBA, gl.UNSIGNED_BYTE, rawData);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

		rawData = new Uint8Array(pixels);
		texture_helper = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture_helper);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sizeX, sizeY, 0, gl.RGBA, gl.UNSIGNED_BYTE, rawData);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

		rawData = new Uint8Array(pixels);
		texture_blur = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture_blur);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sizeX, sizeY, 0, gl.RGBA, gl.UNSIGNED_BYTE, rawData);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

		rawData = new Uint8Array(noisepixels);
		texture_noise_l = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture_noise_l);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sizeX, sizeY, 0, gl.RGBA, gl.UNSIGNED_BYTE, rawData);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

		texture_noise_n = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture_noise_n);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sizeX, sizeY, 0, gl.RGBA, gl.UNSIGNED_BYTE, rawData);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

		// gl.uniform1i(gl.getUniformLocation(prog, "uTexSamp"), 0);
		FBO_main = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, FBO_main);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture_main_l, 0);

		FBO_main2 = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, FBO_main2);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture_main2_l, 0);

		FBO_helper = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, FBO_helper);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture_helper, 0);

		FBO_blur = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, FBO_blur);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture_blur, 0);

		FBO_noise = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, FBO_noise);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture_noise_l, 0);

		gl.useProgram(prog_advance);
		setUniforms(prog_advance);

		gl.useProgram(prog_blur_horizontal);
		gl.uniform2f(gl.getUniformLocation(prog_blur_horizontal, "pixelSize"), 1. / sizeX, 1. / sizeY);
		gl.uniform1i(gl.getUniformLocation(prog_blur_horizontal, "src_tex"), 0);

		gl.useProgram(prog_blur_vertical);
		gl.uniform2f(gl.getUniformLocation(prog_blur_vertical, "pixelSize"), 1. / sizeX, 1. / sizeY);
		gl.uniform1i(gl.getUniformLocation(prog_blur_vertical, "src_tex"), 0);

		gl.useProgram(prog_composite);
		setUniforms(prog_composite);

		gl.activeTexture(gl.TEXTURE2);
		gl.bindTexture(gl.TEXTURE_2D, texture_blur);

		gl.activeTexture(gl.TEXTURE3);
		gl.bindTexture(gl.TEXTURE_2D, texture_noise_l);

		gl.activeTexture(gl.TEXTURE4);
		gl.bindTexture(gl.TEXTURE_2D, texture_noise_n);
/////////////////////////////
/* CALUATING TEXTURE*/
////////////////////////////////////
		calculateBlurTexture();

		timer = setInterval(fr, 500);
		time = new Date().getTime();
		animation = "animate";
		
/////////////////////////////
/* CAll New TEXTURE*/
////////////////////////////////////
		
		anim();
	}
	function setUniforms(program) {
		gl.uniform2f(gl.getUniformLocation(program, "pixelSize"), 1. / sizeX, 1. / sizeY);
		gl.uniform4f(gl.getUniformLocation(program, "rnd"), Math.random(), Math.random(), Math.random(), Math.random());
		gl.uniform1f(gl.getUniformLocation(program, "fps"), fps);
		gl.uniform1f(gl.getUniformLocation(program, "time"), time);
		gl.uniform2f(gl.getUniformLocation(program, "aspect"), Math.max(1, viewX / viewY), Math.max(1, viewY / viewX));
		gl.uniform2f(gl.getUniformLocation(program, "mouse"), mouseX, mouseY);
		gl.uniform1i(gl.getUniformLocation(program, "sampler_prev"), 0);
		gl.uniform1i(gl.getUniformLocation(program, "sampler_prev_n"), 1);
		gl.uniform1i(gl.getUniformLocation(program, "sampler_blur"), 2);
		gl.uniform1i(gl.getUniformLocation(program, "sampler_noise"), 3);
		gl.uniform1i(gl.getUniformLocation(program, "sampler_noise_n"), 4);
	}
	function calculateBlurTexture() {
		// horizontal
		gl.viewport(0, 0, sizeX, sizeY);
		gl.useProgram(prog_blur_horizontal);
		gl.activeTexture(gl.TEXTURE0);
		if (it < 0) {
			gl.bindTexture(gl.TEXTURE_2D, texture_main2_l);
			gl.bindFramebuffer(gl.FRAMEBUFFER, FBO_helper);
		} else {
			gl.bindTexture(gl.TEXTURE_2D, texture_main_l);
			gl.bindFramebuffer(gl.FRAMEBUFFER, FBO_helper);
		}
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.flush();

		// vertical
		gl.viewport(0, 0, sizeX, sizeY);
		gl.useProgram(prog_blur_vertical);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture_helper);
		gl.bindFramebuffer(gl.FRAMEBUFFER, FBO_blur);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.flush();

		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.flush();
	}

	function advance() {
		gl.viewport(0, 0, sizeX, sizeY);
		gl.useProgram(prog_advance);
		setUniforms(prog_advance);
		if (it > 0) {
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, texture_main_l); // interpolated input
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, texture_main_n); // "nearest" input
			gl.bindFramebuffer(gl.FRAMEBUFFER, FBO_main2); // write to buffer
		} else {
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, texture_main2_l); // interpolated
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, texture_main2_n); // "nearest"
			gl.bindFramebuffer(gl.FRAMEBUFFER, FBO_main); // write to buffer
		}
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.flush();

		calculateBlurTexture();
		it = -it;
	}

	function composite() {
		gl.viewport(0, 0, viewX, viewY);
		gl.useProgram(prog_composite);
		setUniforms(prog_composite);
		if (it < 0) {
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, texture_main_l);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, texture_main_n);
		} else {
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, texture_main2_l);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, texture_main2_n);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.flush();
		frames++;
	}

	function anim() {
		if (!halted)
			advance();
		composite();
		switch (animation) {
		case "animate":
			setTimeout("requestAnimFrame(anim)", delay);
			break;
		case "reset":
			load();
			break;
		}
	}
	function setDelay(v) {
		delay = parseInt(v);
	}
	function fr() {
		var ti = new Date().getTime();
		fps = Math.round(1000 * frames / (ti - time));
		document.getElementById("fps").textContent = fps;
		frames = 0;
		time = ti;
	}


