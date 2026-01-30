### A Pluto.jl notebook ###
# v0.20.19

using Markdown
using InteractiveUtils

# ╔═╡ 2d9e9e13-f659-4fd3-b318-6bd3016fbc38
begin
    using Plots
    import ImageShow
    using TestImages
    using PlutoUI
end

# ╔═╡ cfec83b9-4cb3-4f5d-b6ef-799076b66485
plot(x, y)

# ╔═╡ de2172e1-0c9c-44bb-bb14-f5935004e5cd
begin
    x = -pi:0.01:pi
    y = @. f(x - a)
end

# ╔═╡ 1a453479-8e69-4c0e-8d2f-4578d5b74353
@bind a Slider(-1:0.01:1)

# ╔═╡ 63c880b2-5bba-43e2-81e2-efa880aabe6c
@bind f Select([sin, cos, tan])

# ╔═╡ 08311720-0b8b-4c29-9ec3-4593231e3ad3
testimage("mand")

# ╔═╡ f64c9a4d-4ad8-4f0c-9641-9e9a1613ab0a


# ╔═╡ Cell order:
# ╠═2d9e9e13-f659-4fd3-b318-6bd3016fbc38
# ╠═cfec83b9-4cb3-4f5d-b6ef-799076b66485
# ╠═de2172e1-0c9c-44bb-bb14-f5935004e5cd
# ╠═1a453479-8e69-4c0e-8d2f-4578d5b74353
# ╠═63c880b2-5bba-43e2-81e2-efa880aabe6c
# ╠═08311720-0b8b-4c29-9ec3-4593231e3ad3
# ╠═f64c9a4d-4ad8-4f0c-9641-9e9a1613ab0a